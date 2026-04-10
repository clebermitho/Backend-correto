import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { generateSuggestions, generateChatReply } from '../services/openai';
import { prisma } from '../utils/prisma';
import { cache } from '../utils/cache';
import { log } from '../utils/audit';
import logger from '../utils/logger';
import { isCanonicalKnowledgeBaseContent, isCanonicalKnowledgeBaseSourceUrl } from '../utils/knowledgeBaseContract';

const router = Router();

const MAX_TOKENS_CEILING = 4096;
const MIN_TOKENS = 50;

function safeMaxTokens(value: unknown, defaultVal: number): number {
  const n = Number(value);
  if (isNaN(n) || n < MIN_TOKENS) return defaultVal;
  return Math.min(n, MAX_TOKENS_CEILING);
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return undefined;
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(s)) return undefined;
  return s;
}

// ── Cache helpers ─────────────────────────────────────────────

/** Load all org settings — reuses the same cache key as routes/settings.ts.
 *  Cache is invalidated whenever settings are written (PUT /api/settings/*). */
async function loadSettingsCached(orgId: string): Promise<Record<string, unknown>> {
  const key = `settings:${orgId}`;
  const hit = cache.get<Record<string, unknown>>(key);
  if (hit) return hit;
  const rows = await prisma.setting.findMany({
    where:  { organizationId: orgId },
    select: { key: true, value: true },
  });
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  cache.set(key, settings);
  return settings;
}

/** Load active knowledge bases for an org — 2-minute TTL */
async function loadKBsCached(orgId: string): Promise<Array<{ name: string; content: unknown; sourceUrl: string | null }>> {
  const key = `kbs:${orgId}`;
  const hit = cache.get<Array<{ name: string; content: unknown; sourceUrl: string | null }>>(key);
  if (hit) return hit;
  const kbs = await prisma.knowledgeBase.findMany({
    where: { organizationId: orgId, isActive: true },
    select: { name: true, content: true, sourceUrl: true },
  });
  cache.set(key, kbs, 120);
  return kbs;
}

function resolveUnifiedKnowledgeBase(
  kbs: Array<{ name: string; content: unknown; sourceUrl: string | null }>
): Record<string, unknown> | undefined {
  const bySource = kbs.find(
    (kb): kb is { name: string; content: Record<string, unknown>; sourceUrl: string | null } =>
      isCanonicalKnowledgeBaseSourceUrl(kb.sourceUrl) && isCanonicalKnowledgeBaseContent(kb.content)
  );
  if (bySource) return bySource.content;

  const byStructure = kbs.find(
    (kb): kb is { name: string; content: Record<string, unknown>; sourceUrl: string | null } =>
      isCanonicalKnowledgeBaseContent(kb.content)
  );
  if (byStructure) return byStructure.content;

  return undefined;
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
  const org = await prisma.organization.update({
    where: { id: orgId },
    data: { usedTokens: { increment: tokens } },
    select: { usedTokens: true, monthlyQuota: true, name: true },
  });

  const usagePercent = org.monthlyQuota > 0
    ? (org.usedTokens / org.monthlyQuota) * 100
    : 0;

  if (org.usedTokens > org.monthlyQuota) {
    logger.warn({
      event: 'ai.quota_exceeded_after_request',
      orgId,
      orgName: org.name,
      usedTokens: org.usedTokens,
      monthlyQuota: org.monthlyQuota,
      overage: org.usedTokens - org.monthlyQuota,
    });
  } else if (usagePercent >= 90) {
    logger.warn({
      event: 'ai.quota_near_limit',
      orgId,
      orgName: org.name,
      usagePercent: Math.round(usagePercent * 100) / 100,
    });
  }
}

// POST /api/ai/suggestions — extensão envia contexto, recebe 3 sugestões
router.post('/suggestions', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Phase 1: Guards in parallel — fail fast before any heavy work
    await Promise.all([
      checkQuota(req.organizationId!),
      checkDailyLimit(req.user!.id, req.organizationId!, 'suggestions'),
    ]);

    const schema = z.object({
      context:       z.string().min(1),
      question:      z.string().min(1),
      category:      z.string().default('OUTROS'),
      topExamples:   z.array(z.string()).default([]),
      avoidPatterns: z.array(z.string()).default([]),
    });
    const data = schema.parse(req.body);

    // Phase 2: Config loading in parallel (with caching)
    const [settings, kbs] = await Promise.all([
      loadSettingsCached(req.organizationId!),
      loadKBsCached(req.organizationId!),
    ]);

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
      ? safeMaxTokens(settings['suggestion.maxTokens'], 500)
      : 500;

    const promptTemplate = typeof settings['prompt.suggestions'] === 'string'
      ? settings['prompt.suggestions'] as string
      : '';

    const knowledgeBases = Object.fromEntries(kbs.map(kb => [kb.name, kb.content]));
    const unifiedKnowledgeBase = resolveUnifiedKnowledgeBase(kbs);
    if (unifiedKnowledgeBase) {
      knowledgeBases['base-conhecimento'] = unifiedKnowledgeBase;
      knowledgeBases.KNOWLEDGE_CONTEXT = unifiedKnowledgeBase;
    }

    // Phase 3: Load learning data in parallel (depends on settings flags)
    const [topExamples, avoidPatterns] = await Promise.all([
      learnFromApproved
        ? prisma.template.findMany({
            where: {
              organizationId: req.organizationId!,
              isActive: true,
              category: data.category,
            },
            select:  { text: true },
            orderBy: [{ score: 'desc' }, { usageCount: 'desc' }, { updatedAt: 'desc' }],
            take:    3,
          }).then(ts => ts.map(t => t.text).filter(Boolean))
        : Promise.resolve([] as string[]),
      filterRejected
        ? prisma.suggestionFeedback.findMany({
            where: {
              type: 'REJECTED',
              suggestion: { organizationId: req.organizationId!, category: data.category },
            },
            select:  { suggestion: { select: { text: true } } },
            orderBy: { createdAt: 'desc' },
            take:    15,
          }).then(feedbacks =>
            feedbacks
              .map(r => r.suggestion?.text)
              .filter(Boolean)
              .map(t => String(t).trim().slice(0, 80))
              .filter(Boolean)
              .filter((v, i, arr) => arr.indexOf(v) === i)
              .slice(0, 5)
          )
        : Promise.resolve([] as string[]),
    ]);

    // Phase 4: OpenAI call
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

    // Phase 5: Quota update + save suggestions in parallel
    const [, saved] = await Promise.all([
      result.tokensUsed ? updateQuota(req.organizationId!, result.tokensUsed) : Promise.resolve(undefined),
      prisma.$transaction(
        result.suggestions.map(text =>
          prisma.suggestion.create({
            data: { organizationId: req.organizationId!, category: data.category, text, source: 'AI' },
          })
        )
      ),
    ]);

    // Non-blocking audit log — must not delay the response
    log({
      organizationId: req.organizationId!,
      userId:         req.user!.id,
      eventType:      'ai.suggestions_generated',
      payload: {
        category:         data.category,
        count:            result.suggestions.length,
        latencyMs:        result.latencyMs,
        tokensUsed:       result.tokensUsed,
        promptTokens:     result.tokenDetails?.promptTokens,
        completionTokens: result.tokenDetails?.completionTokens,
        cachedTokens:     result.tokenDetails?.cachedTokens,
        model:            result.model ?? 'gpt-4o-mini',
      },
      req,
    }).catch(e => logger.warn({ event: 'audit.log_failed', err: e instanceof Error ? e.message : String(e) }));

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
    // Phase 1: Guards in parallel
    await Promise.all([
      checkQuota(req.organizationId!),
      checkDailyLimit(req.user!.id, req.organizationId!, 'chat'),
    ]);

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

    // Phase 2: Config loading in parallel (with caching)
    const [settings, kbs] = await Promise.all([
      loadSettingsCached(req.organizationId!),
      loadKBsCached(req.organizationId!),
    ]);

    const rawModel = settings['chat.model'] ?? settings['suggestion.model'];
    const model = normalizeModel(rawModel);
    if (typeof rawModel === 'string' && !model) {
      logger.warn({ event: 'ai.invalid_model_setting', orgId: req.organizationId, rawModel: (rawModel as string).slice(0, 80) });
    }

    const temperature = settings['chat.temperature'] !== undefined
      ? Number(settings['chat.temperature'])
      : settings['suggestion.temperature'] !== undefined
        ? Number(settings['suggestion.temperature'])
        : 0.2;

    const maxTokens = settings['chat.maxTokens'] !== undefined
      ? safeMaxTokens(settings['chat.maxTokens'], 600)
      : settings['suggestion.maxTokens'] !== undefined
        ? safeMaxTokens(settings['suggestion.maxTokens'], 600)
        : 600;

    const systemPromptTemplate = typeof settings['prompt.chat'] === 'string' && (settings['prompt.chat'] as string).trim().length > 0
      ? settings['prompt.chat'] as string
      : '';

    const dbKnowledgeBases = Object.fromEntries(kbs.map(kb => [kb.name, kb.content]));
    const unifiedKnowledgeBase = resolveUnifiedKnowledgeBase(kbs);
    if (unifiedKnowledgeBase) {
      dbKnowledgeBases['base-conhecimento'] = unifiedKnowledgeBase;
      dbKnowledgeBases.KNOWLEDGE_CONTEXT = unifiedKnowledgeBase;
    }

    // Phase 3: OpenAI call
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

    // Non-blocking audit log
    log({
      organizationId: req.organizationId!,
      userId:         req.user!.id,
      eventType:      'ai.chat_message',
      payload: {
        latencyMs:        result.latencyMs,
        tokensUsed:       result.tokensUsed,
        promptTokens:     result.tokenDetails?.promptTokens,
        completionTokens: result.tokenDetails?.completionTokens,
        cachedTokens:     result.tokenDetails?.cachedTokens,
        model:            result.model ?? 'gpt-4o-mini',
      },
      req,
    }).catch(e => logger.warn({ event: 'audit.log_failed', err: e instanceof Error ? e.message : String(e) }));

    res.json({ reply: result.reply, latencyMs: result.latencyMs });
  } catch (err) {
    const e = err as Record<string, unknown>;
    if (e.statusCode) { res.status(e.statusCode as number).json({ error: e.message }); return; }
    next(err);
  }
});

export default router;
