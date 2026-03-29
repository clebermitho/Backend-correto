import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { generateSuggestions, generateChatReply } from '../services/openai';
import { prisma } from '../utils/prisma';
import { log } from '../utils/audit';
import logger from '../utils/logger';

const router = Router();

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return undefined;
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(s)) return undefined;
  return s;
}

// ── Auxiliar: Verificar limite diário do usuário ─────────────
async function checkDailyLimit(userId: string, organizationId: string, type: 'chat' | 'suggestions'): Promise<void> {
  const eventType  = type === 'chat' ? 'ai.chat_message' : 'ai.suggestions_generated';
  const limitField = type === 'chat' ? 'dailyChatLimit' : 'dailySuggestionLimit';
  const settingKey = type === 'chat' ? 'limits.chatMessagesPerUserPerDay' : 'limits.suggestionsPerUserPerDay';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { [limitField]: true },
  });

  let limit: number | null | undefined = (user as Record<string, unknown>)?.[limitField] as number | null | undefined;

  if (limit === null || limit === undefined) {
    const setting = await prisma.setting.findUnique({
      where: { organizationId_key: { organizationId, key: settingKey } },
      select: { value: true },
    });
    const globalVal = setting?.value;
    limit = (globalVal !== undefined && globalVal !== null) ? Number(globalVal) : null;
  }

  if (!limit) return;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const count = await prisma.usageEvent.count({
    where: {
      userId,
      eventType,
      createdAt: { gte: startOfDay },
    },
  });

  if (count >= limit) {
    const label = type === 'chat' ? 'mensagens de chat' : 'solicitações de sugestões';
    const err = new Error(`Limite diário de ${label} atingido (${count}/${limit}). Tente novamente amanhã.`) as Error & { statusCode: number };
    err.statusCode = 429;
    throw err;
  }
}

// ── Auxiliar: Verificar e descontar quota ────────────────────
async function checkQuota(orgId: string): Promise<{ monthlyQuota: number; usedTokens: number; name: string }> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { monthlyQuota: true, usedTokens: true, name: true },
  });

  if (!org) throw new Error('Organização não encontrada.');

  if (org.usedTokens >= org.monthlyQuota) {
    logger.warn({ event: 'ai.quota_exceeded', orgId, orgName: org.name });
    const err = new Error('Cota mensal de IA excedida para sua organização.') as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  return org;
}

async function updateQuota(orgId: string, tokens: number): Promise<void> {
  await prisma.organization.update({
    where: { id: orgId },
    data: { usedTokens: { increment: tokens } },
  });
}

// POST /api/ai/suggestions — extensão envia contexto, recebe 3 sugestões
router.post('/suggestions', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await checkQuota(req.organizationId!);
    await checkDailyLimit(req.user!.id, req.organizationId!, 'suggestions');

    const schema = z.object({
      context:       z.string().min(1),
      question:      z.string().min(1),
      category:      z.string().default('OUTROS'),
      topExamples:   z.array(z.string()).default([]),
      avoidPatterns: z.array(z.string()).default([]),
    });

    const data = schema.parse(req.body);

    const settingsRows = await prisma.setting.findMany({
      where:  { organizationId: req.organizationId! },
      select: { key: true, value: true },
    });
    const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    const learnFromApproved = settings['suggestion.learnFromApproved'] !== undefined
      ? Boolean(settings['suggestion.learnFromApproved'])
      : true;
    const filterRejected = settings['suggestion.filterRejected'] !== undefined
      ? Boolean(settings['suggestion.filterRejected'])
      : true;

    const rawModel = settings['suggestion.model'];
    const model = normalizeModel(rawModel);
    if (typeof rawModel === 'string' && !model) {
      logger.warn({ event: 'ai.invalid_model_setting', orgId: req.organizationId, rawModel: (rawModel as string).slice(0, 80) });
    }

    const temperature = settings['suggestion.temperature'] !== undefined
      ? Number(settings['suggestion.temperature'])
      : 0.2;

    const maxTokens = settings['suggestion.maxTokens'] !== undefined
      ? Number(settings['suggestion.maxTokens'])
      : 500;

    const promptTemplate = typeof settings['prompt.suggestions'] === 'string'
      ? settings['prompt.suggestions'] as string
      : '';

    const kbs = await prisma.knowledgeBase.findMany({
      where: { organizationId: req.organizationId!, isActive: true },
    });
    const knowledgeBases = Object.fromEntries(kbs.map(kb => [kb.name, kb.content]));

    const topExamples = learnFromApproved
      ? (await prisma.template.findMany({
          where: {
            organizationId: req.organizationId!,
            isActive: true,
            category: data.category,
          },
          select: { text: true },
          orderBy: [{ score: 'desc' }, { usageCount: 'desc' }, { updatedAt: 'desc' }],
          take: 3,
        })).map(t => t.text).filter(Boolean)
      : [];

    const avoidPatterns = filterRejected
      ? (await prisma.suggestionFeedback.findMany({
          where: {
            type: 'REJECTED',
            suggestion: { organizationId: req.organizationId!, category: data.category },
          },
          select: { suggestion: { select: { text: true } } },
          orderBy: { createdAt: 'desc' },
          take: 15,
        }))
          .map(r => r.suggestion?.text)
          .filter(Boolean)
          .map(t => String(t).trim().slice(0, 80))
          .filter(Boolean)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .slice(0, 5)
      : [];

    const result = await generateSuggestions({
      ...data,
      topExamples,
      avoidPatterns,
      knowledgeBases: knowledgeBases as Record<string, unknown>,
      promptTemplate,
      model,
      temperature,
      maxTokens,
    });

    if (result.tokensUsed) {
      await updateQuota(req.organizationId!, result.tokensUsed);
    }

    const saved = await prisma.$transaction(
      result.suggestions.map(text =>
        prisma.suggestion.create({
          data: { organizationId: req.organizationId!, category: data.category, text, source: 'AI' },
        })
      )
    );

    log({
      organizationId: req.organizationId!,
      userId:         req.user!.id,
      eventType:      'ai.suggestions_generated',
      payload: {
        category:   data.category,
        count:      result.suggestions.length,
        latencyMs:  result.latencyMs,
        tokensUsed: result.tokensUsed,
      },
      req,
    });

    res.json({
      suggestions: saved.map((s, i) => ({ id: s.id, text: result.suggestions[i] })),
      latencyMs:   result.latencyMs,
      tokensUsed:  result.tokensUsed,
    });
  } catch (err) {
    const e = err as Record<string, unknown>;
    if (e.statusCode) { res.status(e.statusCode as number).json({ error: e.message }); return; }
    next(err);
  }
});

// POST /api/ai/chat — chat livre com a IA (bases + system prompt)
router.post('/chat', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await checkQuota(req.organizationId!);
    await checkDailyLimit(req.user!.id, req.organizationId!, 'chat');

    const schema = z.object({
      message:      z.string().min(1),
      history:      z.array(z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })).default([]),
      knowledge:    z.object({
        coren:   z.unknown().optional(),
        sistema: z.unknown().optional(),
      }).optional().default({}),
      systemPrompt: z.string().default(''),
    });

    const { message, history } = schema.parse(req.body);

    const settingsRows = await prisma.setting.findMany({
      where:  { organizationId: req.organizationId! },
      select: { key: true, value: true },
    });
    const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    const rawModel = settings['suggestion.model'];
    const model = normalizeModel(rawModel);
    if (typeof rawModel === 'string' && !model) {
      logger.warn({ event: 'ai.invalid_model_setting', orgId: req.organizationId, rawModel: (rawModel as string).slice(0, 80) });
    }

    const temperature = settings['suggestion.temperature'] !== undefined
      ? Number(settings['suggestion.temperature'])
      : 0.2;

    const maxTokens = settings['suggestion.maxTokens'] !== undefined
      ? Number(settings['suggestion.maxTokens'])
      : 600;

    const systemPromptTemplate = typeof settings['prompt.chat'] === 'string' && (settings['prompt.chat'] as string).trim().length > 0
      ? settings['prompt.chat'] as string
      : '';

    const kbs = await prisma.knowledgeBase.findMany({
      where: { organizationId: req.organizationId!, isActive: true },
    });
    const dbKnowledgeBases = Object.fromEntries(kbs.map(kb => [kb.name, kb.content]));

    const result = await generateChatReply({
      message,
      history,
      systemPromptTemplate,
      dbKnowledgeBases: dbKnowledgeBases as Record<string, unknown>,
      model,
      temperature,
      maxTokens,
    });

    if (result.tokensUsed) {
      await updateQuota(req.organizationId!, result.tokensUsed);
    }

    log({
      organizationId: req.organizationId!,
      userId:         req.user!.id,
      eventType:      'ai.chat_message',
      payload: { latencyMs: result.latencyMs, tokensUsed: result.tokensUsed },
      req,
    });

    res.json({ reply: result.reply, latencyMs: result.latencyMs });
  } catch (err) {
    const e = err as Record<string, unknown>;
    if (e.statusCode) { res.status(e.statusCode as number).json({ error: e.message }); return; }
    next(err);
  }
});

export default router;
