/**
 * /api/v1/ai — versioned AI endpoints with standard response envelope.
 *
 * Differences from legacy /api/ai:
 *  - Standard envelope: { success, data } | { success: false, error: { code, message, details, traceId } }
 *  - Uses AI orchestrator (centralized layer with fallback policy)
 *  - Input sanitization against prompt injection
 *  - Prompt versioning via promptRegistry
 *  - Estimated cost per call in response
 *  - Richer structured logging (traceId, fallbackUsed, estimatedCostUsd)
 *
 * Backward compat: /api/ai/* remains unchanged.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { buildErrorEnvelope } from '../../middleware/errorHandler';
import { orchestrateSuggestions, orchestrateChat } from '../../services/aiOrchestrator';
import { getPrompt } from '../../services/promptRegistry';
import { prisma } from '../../utils/prisma';
import { cache } from '../../utils/cache';
import { log } from '../../utils/audit';
import logger from '../../utils/logger';
import {
  sanitizeContext,
  sanitizeQuestion,
  sanitizeMessage,
  sanitizeHistory,
} from '../../utils/sanitize';

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

// ── Cache helpers (reuse same cache keys as /api/ai for consistency) ──────────

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

async function loadKBsCached(orgId: string): Promise<Array<{ name: string; content: unknown }>> {
  const key = `kbs:${orgId}`;
  const hit = cache.get<Array<{ name: string; content: unknown }>>(key);
  if (hit) return hit;
  const kbs = await prisma.knowledgeBase.findMany({
    where: { organizationId: orgId, isActive: true },
  });
  cache.set(key, kbs, 120);
  return kbs;
}

// ── Quota helpers ────────────────────────────────────────────

async function checkQuota(orgId: string): Promise<{ monthlyQuota: number; usedTokens: number; name: string }> {
  const org = await prisma.organization.findUnique({
    where:  { id: orgId },
    select: { monthlyQuota: true, usedTokens: true, name: true },
  });
  if (!org) throw Object.assign(new Error('Organização não encontrada.'), { statusCode: 404 });
  if (org.usedTokens >= org.monthlyQuota) {
    logger.warn({ event: 'ai.quota_exceeded', orgId, orgName: org.name });
    throw Object.assign(new Error('Cota mensal de IA excedida para sua organização.'), { statusCode: 403 });
  }
  return org;
}

async function updateQuota(orgId: string, tokens: number): Promise<void> {
  const org = await prisma.organization.update({
    where:  { id: orgId },
    data:   { usedTokens: { increment: tokens } },
    select: { usedTokens: true, monthlyQuota: true, name: true },
  });
  const usagePercent = org.monthlyQuota > 0 ? (org.usedTokens / org.monthlyQuota) * 100 : 0;
  if (org.usedTokens > org.monthlyQuota) {
    logger.warn({
      event:        'ai.quota_exceeded_after_request',
      orgId,
      orgName:      org.name,
      usedTokens:   org.usedTokens,
      monthlyQuota: org.monthlyQuota,
      overage:      org.usedTokens - org.monthlyQuota,
    });
  } else if (usagePercent >= 90) {
    logger.warn({
      event:        'ai.quota_near_limit',
      orgId,
      orgName:      org.name,
      usagePercent: Math.round(usagePercent * 100) / 100,
    });
  }
}

async function checkDailyLimit(userId: string, organizationId: string, type: 'chat' | 'suggestions'): Promise<void> {
  const eventType  = type === 'chat' ? 'ai.chat_message' : 'ai.suggestions_generated';
  const limitField = type === 'chat' ? 'dailyChatLimit' : 'dailySuggestionLimit';
  const settingKey = type === 'chat' ? 'limits.chatMessagesPerUserPerDay' : 'limits.suggestionsPerUserPerDay';

  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { [limitField]: true },
  });

  let limit: number | null | undefined = (user as Record<string, unknown>)?.[limitField] as number | null | undefined;

  if (limit === null || limit === undefined) {
    const setting = await prisma.setting.findUnique({
      where:  { organizationId_key: { organizationId, key: settingKey } },
      select: { value: true },
    });
    const globalVal = setting?.value;
    limit = (globalVal !== undefined && globalVal !== null) ? Number(globalVal) : null;
  }

  if (!limit) return;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const count = await prisma.usageEvent.count({
    where: { userId, eventType, createdAt: { gte: startOfDay } },
  });

  if (count >= limit) {
    const label = type === 'chat' ? 'mensagens de chat' : 'solicitações de sugestões';
    throw Object.assign(
      new Error(`Limite diário de ${label} atingido (${count}/${limit}). Tente novamente amanhã.`),
      { statusCode: 429 }
    );
  }
}

// ── POST /api/v1/ai/suggestions ───────────────────────────────

router.post('/suggestions', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const traceId = req.headers['x-request-id'] as string | undefined;

  try {
    await Promise.all([
      checkQuota(req.organizationId!),
      checkDailyLimit(req.user!.id, req.organizationId!, 'suggestions'),
    ]);

    const schema = z.object({
      context:       z.string().min(1).max(10_000),
      question:      z.string().min(1).max(3_000),
      category:      z.string().default('OUTROS'),
      topExamples:   z.array(z.string()).default([]),
      avoidPatterns: z.array(z.string()).default([]),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(buildErrorEnvelope(
        'VALIDATION_ERROR',
        'Dados inválidos.',
        req,
        parsed.error.errors.map(e => ({ path: e.path.join('.'), message: e.message }))
      ));
      return;
    }
    const data = parsed.data;

    // Sanitize inputs against prompt injection
    const ctxResult  = sanitizeContext(data.context);
    const qResult    = sanitizeQuestion(data.question);

    if (ctxResult.flagged || qResult.flagged) {
      logger.warn({
        event:   'ai.v1.injection_attempt',
        traceId,
        orgId:   req.organizationId,
        userId:  req.user?.id,
        reason:  ctxResult.reason ?? qResult.reason,
      });
      res.status(400).json(buildErrorEnvelope(
        'INVALID_INPUT',
        'Entrada rejeitada por conter conteúdo não permitido.',
        req
      ));
      return;
    }

    const [settings, kbs] = await Promise.all([
      loadSettingsCached(req.organizationId!),
      loadKBsCached(req.organizationId!),
    ]);

    const rawModel = settings['suggestion.model'];
    const model    = normalizeModel(rawModel);
    const temperature = settings['suggestion.temperature'] !== undefined
      ? Number(settings['suggestion.temperature'])
      : 0.2;
    const maxTokens = settings['suggestion.maxTokens'] !== undefined
      ? safeMaxTokens(settings['suggestion.maxTokens'], 500)
      : 500;

    // Prompt versioning: try registry first, fall back to DB setting, then hardcoded default
    const registryPrompt = await getPrompt(req.organizationId!, 'suggestions', 'latest').catch(() => undefined);
    const promptTemplate = registryPrompt?.template
      ?? (typeof settings['prompt.suggestions'] === 'string' ? settings['prompt.suggestions'] as string : '');

    const learnFromApproved = settings['suggestion.learnFromApproved'] !== false;
    const filterRejected    = settings['suggestion.filterRejected'] !== false;

    const [topExamples, avoidPatterns] = await Promise.all([
      learnFromApproved
        ? prisma.template.findMany({
            where:   { organizationId: req.organizationId!, isActive: true, category: data.category },
            select:  { text: true },
            orderBy: [{ score: 'desc' }, { usageCount: 'desc' }, { updatedAt: 'desc' }],
            take:    3,
          }).then(ts => ts.map(t => t.text).filter(Boolean))
        : Promise.resolve([] as string[]),
      filterRejected
        ? prisma.suggestionFeedback.findMany({
            where: {
              type:       'REJECTED',
              suggestion: { organizationId: req.organizationId!, category: data.category },
            },
            select:  { suggestion: { select: { text: true } } },
            orderBy: { createdAt: 'desc' },
            take:    15,
          }).then(feedbacks =>
            Array.from(new Set(
              feedbacks
                .map(r => r.suggestion?.text)
                .filter(Boolean)
                .map(t => String(t).trim().slice(0, 80))
                .filter(Boolean)
            )).slice(0, 5)
          )
        : Promise.resolve([] as string[]),
    ]);

    const knowledgeBases = Object.fromEntries(kbs.map(kb => [kb.name, kb.content]));

    // Orchestrate call (includes fallback policy)
    const result = await orchestrateSuggestions({
      context:        ctxResult.value,
      question:       qResult.value,
      category:       data.category,
      topExamples,
      avoidPatterns,
      knowledgeBases: knowledgeBases as Record<string, unknown>,
      promptTemplate,
      model,
      temperature,
      maxTokens,
      traceId,
      organizationId: req.organizationId,
    });

    const [, saved] = await Promise.all([
      result.tokensUsed ? updateQuota(req.organizationId!, result.tokensUsed) : Promise.resolve(undefined),
      prisma.$transaction(
        result.data.suggestions.map(text =>
          prisma.suggestion.create({
            data: { organizationId: req.organizationId!, category: data.category, text, source: 'AI' },
          })
        )
      ),
    ]);

    log({
      organizationId: req.organizationId!,
      userId:         req.user!.id,
      eventType:      'ai.suggestions_generated',
      payload: {
        traceId,
        category:         data.category,
        count:            result.data.suggestions.length,
        latencyMs:        result.latencyMs,
        tokensUsed:       result.tokensUsed,
        promptTokens:     result.tokenDetails?.promptTokens,
        completionTokens: result.tokenDetails?.completionTokens,
        cachedTokens:     result.tokenDetails?.cachedTokens,
        model:            result.model,
        estimatedCostUsd: result.estimatedCostUsd,
        fallbackUsed:     result.fallbackUsed,
        fallbackReason:   result.fallbackReason,
        promptSource:     registryPrompt ? `registry:${registryPrompt.version}` : 'settings',
      },
      req,
    }).catch(e => logger.warn({ event: 'audit.log_failed', err: e instanceof Error ? e.message : String(e) }));

    res.json({
      success: true,
      data: {
        suggestions:      saved.map((s, i) => ({ id: s.id, text: result.data.suggestions[i] })),
        latencyMs:        result.latencyMs,
        tokensUsed:       result.tokensUsed,
        model:            result.model,
        estimatedCostUsd: result.estimatedCostUsd,
        fallbackUsed:     result.fallbackUsed,
      },
      traceId,
    });
  } catch (err) {
    const e = err as Record<string, unknown>;
    if (e.statusCode) {
      res.status(e.statusCode as number).json(buildErrorEnvelope(
        statusToCode(e.statusCode as number),
        String(e.message),
        req
      ));
      return;
    }
    next(err);
  }
});

// ── POST /api/v1/ai/chat ──────────────────────────────────────

router.post('/chat', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const traceId = req.headers['x-request-id'] as string | undefined;

  try {
    await Promise.all([
      checkQuota(req.organizationId!),
      checkDailyLimit(req.user!.id, req.organizationId!, 'chat'),
    ]);

    const schema = z.object({
      message: z.string().min(1).max(6_000),
      history: z.array(z.object({
        role:    z.enum(['user', 'assistant']),
        content: z.string().max(3_000),
      })).default([]),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(buildErrorEnvelope(
        'VALIDATION_ERROR',
        'Dados inválidos.',
        req,
        parsed.error.errors.map(e => ({ path: e.path.join('.'), message: e.message }))
      ));
      return;
    }

    const msgResult = sanitizeMessage(parsed.data.message);
    if (msgResult.flagged) {
      logger.warn({
        event:  'ai.v1.injection_attempt',
        traceId,
        orgId:  req.organizationId,
        userId: req.user?.id,
        reason: msgResult.reason,
      });
      res.status(400).json(buildErrorEnvelope(
        'INVALID_INPUT',
        'Entrada rejeitada por conter conteúdo não permitido.',
        req
      ));
      return;
    }

    const safeHistory = sanitizeHistory(parsed.data.history);

    const [settings, kbs] = await Promise.all([
      loadSettingsCached(req.organizationId!),
      loadKBsCached(req.organizationId!),
    ]);

    const rawModel    = settings['chat.model'] ?? settings['suggestion.model'];
    const model       = normalizeModel(rawModel);
    const temperature = settings['chat.temperature'] !== undefined
      ? Number(settings['chat.temperature'])
      : settings['suggestion.temperature'] !== undefined
        ? Number(settings['suggestion.temperature'])
        : 0.2;
    const maxTokens = settings['chat.maxTokens'] !== undefined
      ? safeMaxTokens(settings['chat.maxTokens'], 600)
      : 600;

    // Prompt versioning: try registry first, fall back to DB setting
    const registryPrompt = await getPrompt(req.organizationId!, 'chat', 'latest').catch(() => undefined);
    const systemPromptTemplate = registryPrompt?.template
      ?? (typeof settings['prompt.chat'] === 'string' && (settings['prompt.chat'] as string).trim().length > 0
          ? settings['prompt.chat'] as string
          : '');

    const dbKnowledgeBases = Object.fromEntries(kbs.map(kb => [kb.name, kb.content]));

    const result = await orchestrateChat({
      message:              msgResult.value,
      history:              safeHistory,
      systemPromptTemplate,
      dbKnowledgeBases:     dbKnowledgeBases as Record<string, unknown>,
      model,
      temperature,
      maxTokens,
      traceId,
      organizationId:       req.organizationId,
    });

    if (result.tokensUsed) {
      await updateQuota(req.organizationId!, result.tokensUsed);
    }

    log({
      organizationId: req.organizationId!,
      userId:         req.user!.id,
      eventType:      'ai.chat_message',
      payload: {
        traceId,
        latencyMs:        result.latencyMs,
        tokensUsed:       result.tokensUsed,
        promptTokens:     result.tokenDetails?.promptTokens,
        completionTokens: result.tokenDetails?.completionTokens,
        cachedTokens:     result.tokenDetails?.cachedTokens,
        model:            result.model,
        estimatedCostUsd: result.estimatedCostUsd,
        fallbackUsed:     result.fallbackUsed,
        fallbackReason:   result.fallbackReason,
        promptSource:     registryPrompt ? `registry:${registryPrompt.version}` : 'settings',
      },
      req,
    }).catch(e => logger.warn({ event: 'audit.log_failed', err: e instanceof Error ? e.message : String(e) }));

    res.json({
      success: true,
      data: {
        reply:            result.data.reply,
        latencyMs:        result.latencyMs,
        tokensUsed:       result.tokensUsed,
        model:            result.model,
        estimatedCostUsd: result.estimatedCostUsd,
        fallbackUsed:     result.fallbackUsed,
      },
      traceId,
    });
  } catch (err) {
    const e = err as Record<string, unknown>;
    if (e.statusCode) {
      res.status(e.statusCode as number).json(buildErrorEnvelope(
        statusToCode(e.statusCode as number),
        String(e.message),
        req
      ));
      return;
    }
    next(err);
  }
});

function statusToCode(status: number): string {
  const map: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR',
    502: 'UPSTREAM_ERROR',
    503: 'SERVICE_UNAVAILABLE',
    504: 'TIMEOUT',
  };
  return map[status] ?? 'ERROR';
}

export default router;
