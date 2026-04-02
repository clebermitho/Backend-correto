/**
 * AI Orchestrator — central layer for all LLM interactions.
 *
 * Responsibilities:
 *   1. Single entry point for all LLM calls (no direct openai.ts usage from routes in v1)
 *   2. Fallback policy by error class: timeout, rate-limit, provider error, context overflow
 *   3. Primary / secondary model strategy (configurable via env)
 *   4. Structured logging of every call, including fallback events
 *   5. Latency measurement and cost estimation extension point
 *
 * Architecture decision:
 *   This layer wraps `services/openai.ts` instead of replacing it to preserve backward
 *   compat for existing /api/* routes. The openai.ts functions remain the concrete
 *   transport layer; the orchestrator adds policy/observability on top.
 *
 * Trade-off:
 *   Keeping openai.ts unchanged avoids touching the existing route handlers.
 *   The downside is two layers for now — acceptable until /api/v1 stabilises and
 *   the legacy routes are migrated.
 */

import {
  callOpenAI,
  generateSuggestions,
  generateChatReply,
} from './openai';
import logger from '../utils/logger';

// ── Model/cost configuration ─────────────────────────────────

/** OpenAI cost per 1k tokens (input / output) — used for estimation only */
const MODEL_COST_PER_1K: Record<string, { input: number; output: number }> = {
  'gpt-4o':          { input: 0.005,  output: 0.015  },
  'gpt-4o-mini':     { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo':     { input: 0.01,   output: 0.03   },
  'gpt-3.5-turbo':   { input: 0.0005, output: 0.0015 },
};

function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number | undefined {
  const costs = MODEL_COST_PER_1K[model];
  if (!costs) return undefined;
  return (
    (promptTokens / 1000) * costs.input +
    (completionTokens / 1000) * costs.output
  );
}

// ── Error classification ──────────────────────────────────────

export type AIErrorClass =
  | 'timeout'
  | 'rate_limit'
  | 'provider_error'
  | 'context_overflow'
  | 'no_api_key'
  | 'unknown';

function classifyError(err: unknown): AIErrorClass {
  const e = err as Error & { statusCode?: number };
  const msg = e.message || '';
  const code = e.statusCode;

  if (e.name === 'AbortError' || msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
    return 'timeout';
  }
  if (code === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('529')) {
    // 429 = standard HTTP rate limit; 529 = OpenAI-specific "site overloaded" / capacity limit
    return 'rate_limit';
  }
  if (msg.includes('context') && (msg.includes('length') || msg.includes('maximum'))) {
    return 'context_overflow';
  }
  if (msg.includes('não configurado') || msg.includes('API Key')) {
    return 'no_api_key';
  }
  if (code === 502 || code === 503 || msg.includes('502') || msg.includes('503')) {
    return 'provider_error';
  }
  return 'unknown';
}

function shouldFallback(errorClass: AIErrorClass): boolean {
  return (
    errorClass === 'timeout' ||
    errorClass === 'rate_limit' ||
    errorClass === 'provider_error' ||
    errorClass === 'context_overflow'
  );
}

function getFallbackModel(): string {
  // Allow explicit override via env; default to a cheaper/faster model
  return process.env.AI_FALLBACK_MODEL || 'gpt-4o-mini';
}

function getPrimaryModel(orgModel?: string): string {
  return orgModel || process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

// ── Orchestrated suggestion generation ───────────────────────

export interface OrchestratorSuggestionsOptions {
  context: string;
  question: string;
  category: string;
  topExamples?: string[];
  avoidPatterns?: string[];
  knowledgeBases?: Record<string, unknown>;
  promptTemplate?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  traceId?: string;
  organizationId?: string;
}

export interface OrchestratorResult<T> {
  data: T;
  latencyMs: number;
  model: string;
  tokensUsed?: number;
  tokenDetails?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
  };
  estimatedCostUsd?: number;
  fallbackUsed: boolean;
  fallbackReason?: string;
  errorClass?: AIErrorClass;
}

export async function orchestrateSuggestions(
  opts: OrchestratorSuggestionsOptions
): Promise<OrchestratorResult<{ suggestions: string[] }>> {
  const primaryModel = getPrimaryModel(opts.model);
  const callStart = Date.now();
  let fallbackUsed = false;
  let fallbackReason: string | undefined;
  let errorClass: AIErrorClass | undefined;

  const doCall = async (model: string) =>
    generateSuggestions({ ...opts, model, temperature: opts.temperature, maxTokens: opts.maxTokens });

  let result: Awaited<ReturnType<typeof generateSuggestions>>;

  try {
    result = await doCall(primaryModel);
  } catch (primaryErr) {
    errorClass = classifyError(primaryErr);
    const fallbackModel = getFallbackModel();

    if (!shouldFallback(errorClass) || fallbackModel === primaryModel) {
      throw primaryErr;
    }

    fallbackUsed = true;
    fallbackReason = errorClass;

    logger.warn({
      event:          'ai.orchestrator.fallback',
      traceId:        opts.traceId,
      orgId:          opts.organizationId,
      primaryModel,
      fallbackModel,
      errorClass,
      primaryError:   (primaryErr as Error).message?.slice(0, 200),
    });

    try {
      result = await doCall(fallbackModel);
    } catch (fallbackErr) {
      logger.error({
        event:         'ai.orchestrator.fallback_failed',
        traceId:       opts.traceId,
        orgId:         opts.organizationId,
        primaryModel,
        fallbackModel,
        errorClass,
        fallbackError: (fallbackErr as Error).message?.slice(0, 200),
      });
      throw fallbackErr;
    }
  }

  const estimatedCostUsd = estimateCostUsd(
    result.model,
    result.tokenDetails?.promptTokens ?? 0,
    result.tokenDetails?.completionTokens ?? 0
  );

  logger.info({
    event:            'ai.orchestrator.suggestions_ok',
    traceId:          opts.traceId,
    orgId:            opts.organizationId,
    category:         opts.category,
    count:            result.suggestions.length,
    latencyMs:        result.latencyMs,
    model:            result.model,
    tokens:           result.tokensUsed,
    estimatedCostUsd,
    fallbackUsed,
    fallbackReason,
  });

  return {
    data:             { suggestions: result.suggestions },
    latencyMs:        result.latencyMs,
    model:            result.model,
    tokensUsed:       result.tokensUsed,
    tokenDetails:     result.tokenDetails,
    estimatedCostUsd,
    fallbackUsed,
    fallbackReason,
    errorClass,
  };
}

// ── Orchestrated chat reply ───────────────────────────────────

export interface OrchestratorChatOptions {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPromptTemplate?: string;
  dbKnowledgeBases?: Record<string, unknown>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  traceId?: string;
  organizationId?: string;
}

export async function orchestrateChat(
  opts: OrchestratorChatOptions
): Promise<OrchestratorResult<{ reply: string }>> {
  const primaryModel = getPrimaryModel(opts.model);
  let fallbackUsed = false;
  let fallbackReason: string | undefined;
  let errorClass: AIErrorClass | undefined;

  const doCall = async (model: string) =>
    generateChatReply({ ...opts, model, temperature: opts.temperature, maxTokens: opts.maxTokens });

  let result: Awaited<ReturnType<typeof generateChatReply>>;

  try {
    result = await doCall(primaryModel);
  } catch (primaryErr) {
    errorClass = classifyError(primaryErr);
    const fallbackModel = getFallbackModel();

    if (!shouldFallback(errorClass) || fallbackModel === primaryModel) {
      throw primaryErr;
    }

    fallbackUsed = true;
    fallbackReason = errorClass;

    logger.warn({
      event:         'ai.orchestrator.fallback',
      traceId:       opts.traceId,
      orgId:         opts.organizationId,
      primaryModel,
      fallbackModel,
      errorClass,
      primaryError:  (primaryErr as Error).message?.slice(0, 200),
    });

    try {
      result = await doCall(fallbackModel);
    } catch (fallbackErr) {
      logger.error({
        event:         'ai.orchestrator.fallback_failed',
        traceId:       opts.traceId,
        orgId:         opts.organizationId,
        primaryModel,
        fallbackModel,
        errorClass,
        fallbackError: (fallbackErr as Error).message?.slice(0, 200),
      });
      throw fallbackErr;
    }
  }

  const estimatedCostUsd = estimateCostUsd(
    result.model,
    result.tokenDetails?.promptTokens ?? 0,
    result.tokenDetails?.completionTokens ?? 0
  );

  logger.info({
    event:            'ai.orchestrator.chat_ok',
    traceId:          opts.traceId,
    orgId:            opts.organizationId,
    latencyMs:        result.latencyMs,
    model:            result.model,
    tokens:           result.tokensUsed,
    estimatedCostUsd,
    fallbackUsed,
    fallbackReason,
  });

  return {
    data:             { reply: result.reply },
    latencyMs:        result.latencyMs,
    model:            result.model,
    tokensUsed:       result.tokensUsed,
    tokenDetails:     result.tokenDetails,
    estimatedCostUsd,
    fallbackUsed,
    fallbackReason,
    errorClass,
  };
}

// ── Re-export callOpenAI for direct use if needed ─────────────
export { callOpenAI };
