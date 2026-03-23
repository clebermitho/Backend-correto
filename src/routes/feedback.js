const router = require('express').Router();
const { z }  = require('zod');
const { prisma }      = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { log }         = require('../utils/audit');
const logger          = require('../utils/logger');

const feedbackSchema = z.object({
  suggestionId: z.string().min(1),
  type:         z.enum(['APPROVED', 'REJECTED', 'USED', 'IGNORED']),
  reason:       z.string().max(500).nullish().transform(v => v ?? undefined),
});

// ── POST /api/feedback ───────────────────────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const data = feedbackSchema.parse(req.body);

    // Guard: organizationId obrigatório
    if (!req.organizationId) {
      return res.status(400).json({ error: 'Usuário sem organização associada.' });
    }

    // Garante que a sugestão pertence à org (evita cross-org)
    const suggestion = await prisma.suggestion.findFirst({
      where: { id: data.suggestionId, organizationId: req.organizationId },
    });
    if (!suggestion) {
      // Sugestão não encontrada — pode ter sido deletada ou ser de sessão anterior
      // Retornar 200 (ignorado) para evitar cascata de erros na extensão
      logger.warn({ event: 'feedback.suggestion_not_found', suggestionId: data.suggestionId, userId: req.user.id });
      return res.status(200).json({ ignored: true, reason: 'suggestion_not_found' });
    }

    // Previne feedback duplicado do mesmo usuário para o mesmo tipo (idempotente)
    const existing = await prisma.suggestionFeedback.findFirst({
      where: { suggestionId: data.suggestionId, userId: req.user.id, type: data.type },
    });
    if (existing) {
      return res.status(200).json(existing); // idempotente
    }

    const feedback = await prisma.suggestionFeedback.create({
      data: { ...data, userId: req.user.id },
    });

    // Recalcular score (a sugestão já foi validada como desta org no findFirst acima)
    // Filtramos apenas por suggestionId — o filtro de org via relação pode causar erros no Prisma 5
    // USADO (USED) e APROVADO (APPROVED) contam como positivo
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
          // IGNORED não entra no cálculo de score (neutro)
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

    // Promover para template se score >= 0.8 e usageCount >= 3 (aprendizado automático)
    const updatedSuggestion = await prisma.suggestion.findUnique({
      where: { id: data.suggestionId },
    });
    if (
      updatedSuggestion &&
      updatedSuggestion.score >= 0.8 &&
      updatedSuggestion.usageCount >= 3
    ) {
      // Verifica se já existe template idêntico
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
        }).catch(() => {}); // não bloquear se falhar
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
      userId:         req.user.id,
      eventType:      `suggestion.${data.type.toLowerCase()}`,
      payload:        { suggestionId: data.suggestionId, reason: data.reason },
    });

    logger.info({
      event:        `feedback.${data.type.toLowerCase()}`,
      userId:       req.user.id,
      suggestionId: data.suggestionId,
      newScore,
    });

    res.status(201).json(feedback);
  } catch (err) { next(err); }
});

// ── GET /api/feedback/rejected — sugestões reprovadas da org ─
// ATENÇÃO: retorna campo "rejected" (não "feedback") — alinhado com o admin e a extensão
router.get('/rejected', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const since = req.query.since ? new Date(req.query.since) : null;

    const rejected = await prisma.suggestionFeedback.findMany({
      where: {
        type: 'REJECTED',
        user: { organizationId: req.organizationId },
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

module.exports = router;
