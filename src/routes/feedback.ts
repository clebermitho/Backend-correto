import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';
import { log } from '../utils/audit';
import logger from '../utils/logger';

const router = Router();

const feedbackSchema = z.object({
  suggestionId: z.string().min(1),
  type:         z.enum(['APPROVED', 'REJECTED', 'USED', 'IGNORED']),
  reason:       z.string().max(500).nullish().transform(v => v ?? undefined),
});

// ── POST /api/feedback ───────────────────────────────────────
router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = feedbackSchema.parse(req.body);

    if (!req.organizationId) {
      res.status(400).json({ error: 'Usuário sem organização associada.' });
      return;
    }

    const suggestion = await prisma.suggestion.findFirst({
      where: { id: data.suggestionId, organizationId: req.organizationId },
    });
    if (!suggestion) {
      logger.warn({ event: 'feedback.suggestion_not_found', suggestionId: data.suggestionId, userId: req.user!.id });
      res.status(200).json({ ignored: true, reason: 'suggestion_not_found' });
      return;
    }

    const existing = await prisma.suggestionFeedback.findFirst({
      where: { suggestionId: data.suggestionId, userId: req.user!.id, type: data.type },
    });
    if (existing) {
      res.status(200).json(existing);
      return;
    }

    const feedback = await prisma.suggestionFeedback.create({
      data: { ...data, userId: req.user!.id },
    });

    const [approvedCount, totalCount] = await Promise.all([
      prisma.suggestionFeedback.count({
        where: {
          suggestionId: data.suggestionId,
          type: { in: ['APPROVED', 'USED'] },
        },
      }),
      prisma.suggestionFeedback.count({
        where: {
          suggestionId: data.suggestionId,
          type: { in: ['APPROVED', 'USED', 'REJECTED'] },
        },
      }),
    ]);

    const newScore  = totalCount > 0 ? parseFloat((approvedCount / totalCount).toFixed(3)) : 0;
    const usageIncr = data.type === 'USED' ? 1 : 0;

    await prisma.suggestion.update({
      where: { id: data.suggestionId },
      data:  { score: newScore, usageCount: { increment: usageIncr } },
    });

    const settingsRows = await prisma.setting.findMany({
      where:  { organizationId: req.organizationId },
      select: { key: true, value: true },
    });
    const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    const learnFromApproved = settings['suggestion.learnFromApproved'] !== undefined
      ? Boolean(settings['suggestion.learnFromApproved'])
      : true;

    const minApprovalScoreToLearn = settings['suggestion.minApprovalScoreToLearn'] !== undefined
      ? Number(settings['suggestion.minApprovalScoreToLearn'])
      : 0.8;

    const updatedSuggestion = await prisma.suggestion.findUnique({
      where: { id: data.suggestionId },
    });
    if (
      updatedSuggestion &&
      learnFromApproved &&
      updatedSuggestion.score >= minApprovalScoreToLearn &&
      updatedSuggestion.usageCount >= 3
    ) {
      const existingTemplate = await prisma.template.findFirst({
        where: { organizationId: req.organizationId, text: updatedSuggestion.text },
      });
      if (!existingTemplate) {
        await prisma.template.create({
          data: {
            organizationId: req.organizationId,
            category:       updatedSuggestion.category,
            text:           updatedSuggestion.text,
            score:          updatedSuggestion.score,
            usageCount:     updatedSuggestion.usageCount,
          },
        }).catch(() => {});
        logger.info({
          event:        'template.auto_learned',
          suggestionId: data.suggestionId,
          category:     updatedSuggestion.category,
          score:        updatedSuggestion.score,
        });
      }
    }

    log({
      organizationId: req.organizationId,
      userId:         req.user!.id,
      eventType:      `suggestion.${data.type.toLowerCase()}`,
      payload:        { suggestionId: data.suggestionId, reason: data.reason },
    });

    logger.info({
      event:        `feedback.${data.type.toLowerCase()}`,
      userId:       req.user!.id,
      suggestionId: data.suggestionId,
      newScore,
    });

    res.status(201).json(feedback);
  } catch (err) { next(err); }
});

// ── GET /api/feedback/rejected — sugestões reprovadas da org ─
router.get('/rejected', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const since = req.query.since ? new Date(req.query.since as string) : null;

    const rejected = await prisma.suggestionFeedback.findMany({
      where: {
        type: 'REJECTED',
        user: { organizationId: req.organizationId! },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      include: {
        suggestion: { select: { id: true, text: true, category: true } },
        user:       { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    });

    res.json({ rejected, total: rejected.length });
  } catch (err) { next(err); }
});

export default router;
