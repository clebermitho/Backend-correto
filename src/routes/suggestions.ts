import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';
import { log } from '../utils/audit';

const router = Router();

// GET /api/suggestions?category=NEGOCIACAO&limit=5
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const category = req.query.category as string | undefined;
    const limit    = Math.min(parseInt(req.query.limit as string) || 5, 20);

    const suggestions = await prisma.suggestion.findMany({
      where: {
        organizationId: req.organizationId!,
        ...(category ? { category } : {}),
      },
      orderBy: [{ score: 'desc' }, { usageCount: 'desc' }],
      take:    limit,
      select:  { id: true, category: true, text: true, score: true, usageCount: true, source: true },
    });

    res.json({ suggestions });
  } catch (err) { next(err); }
});

// POST /api/suggestions — salvar sugestão gerada pela IA
router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({
      category: z.string(),
      text:     z.string().min(5),
      source:   z.enum(['AI', 'TEMPLATE', 'MANUAL']).default('AI'),
    });
    const data = schema.parse(req.body);

    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const existing = await prisma.suggestion.findFirst({
      where: {
        organizationId: req.organizationId!,
        text: data.text,
        createdAt: { gte: since24h },
      },
    });

    if (existing) {
      res.status(200).json(existing);
      return;
    }

    const suggestion = await prisma.suggestion.create({
      data: { ...data, organizationId: req.organizationId! },
    });

    log({ organizationId: req.organizationId!, userId: req.user!.id,
          eventType: 'suggestion.saved', payload: { id: suggestion.id, category: data.category } });

    res.status(201).json(suggestion);
  } catch (err) { next(err); }
});

// POST /api/suggestions/batch — salvar lote com deduplicação
router.post('/batch', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({
      suggestions: z.array(z.object({
        category: z.string(),
        text:     z.string().min(5),
        source:   z.enum(['AI', 'TEMPLATE', 'MANUAL']).default('AI'),
      })).min(1).max(10),
    });
    const { suggestions } = schema.parse(req.body);

    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const texts = suggestions.map(s => s.text);

    const existingTexts = await prisma.suggestion.findMany({
      where: {
        organizationId: req.organizationId!,
        text:           { in: texts },
        createdAt:      { gte: since24h },
      },
      select: { text: true, id: true },
    });
    const existingSet = new Map(existingTexts.map(e => [e.text, e]));

    const toCreate = suggestions.filter(s => !existingSet.has(s.text));
    const reused   = suggestions
      .filter(s => existingSet.has(s.text))
      .map(s => existingSet.get(s.text));

    let created: typeof reused = [];
    if (toCreate.length > 0) {
      created = await prisma.$transaction(
        toCreate.map(s =>
          prisma.suggestion.create({ data: { ...s, organizationId: req.organizationId! } })
        )
      );
    }

    const all = [...created, ...reused];

    if (created.length > 0) {
      log({ organizationId: req.organizationId!, userId: req.user!.id,
            eventType: 'suggestion.batch_saved', payload: { count: created.length, deduped: reused.length } });
    }

    res.status(201).json({ suggestions: all, created: created.length, deduped: reused.length });
  } catch (err) { next(err); }
});

export default router;
