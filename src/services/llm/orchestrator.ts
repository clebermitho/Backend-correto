/**
 * LLM Orchestrator
 *
 * Central point for all LLM calls in the application.
 * Responsibilities:
 *  - Retry with exponential backoff
 *  - Fallback to secondary model on specific error types
 *  - Structured observability logging per call
 *  - Consistent error mapping to LLMError
 *
 * Design decision: the orchestrator does NOT persist AICallLog entries itself
 * (to avoid a Prisma import here — that coupling belongs in the route layer).
 * Instead, it returns `OrchestratorResult` with all fields needed for logging.
 *
 * Future: circuit breaker state can be injected as a dependency.
 */

import type { LLMProvider, OrchestratorOptions, OrchestratorResult } from './types';
import { LLMError } from './types';
import { openAIProvider } from './providers/openai';
import logger from '../../utils/logger';

/** Error types that should trigger fallback to the secondary model */
const FALLBACK_TRIGGER_TYPES = new Set<string>([
  'timeout',
  'rate_limit',
  'provider_error',
]);

/** Error types that should be retried (before falling back) */
const RETRYABLE_TYPES = new Set<string>([
  'timeout',
  'rate_limit',
  'provider_error',
]);

const BASE_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function jitteredDelay(attempt: number): number {
  return BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
}

export class LLMOrchestrator {
  private readonly primaryProvider: LLMProvider;

  constructor(provider: LLMProvider = openAIProvider) {
    this.primaryProvider = provider;
  }

  async call(options: OrchestratorOptions): Promise<OrchestratorResult> {
    const {
      fallbackModel,
      maxRetries = 3,
      callType   = 'unknown' as string,
      traceId,
      model: primaryModel,
      ...callOptions
    } = options;

    let retryCount     = 0;
    let fallbackUsed   = false;
    let lastError: LLMError | null = null;

    // ── Primary model with retries ───────────────────────────
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.primaryProvider.call({
          ...callOptions,
          model: primaryModel,
        });
        this.logSuccess({ result, callType, traceId, retryCount, fallbackUsed });
        return { ...result, fallbackUsed, retryCount, callType };
      } catch (err) {
        const llmErr = this.normalizeError(err);
        lastError    = llmErr;

        if (!RETRYABLE_TYPES.has(llmErr.type) || attempt === maxRetries) {
          break;
        }

        const waitMs = jitteredDelay(attempt);
        logger.warn({
          event:     'llm.retry',
          callType,
          traceId,
          attempt,
          errorType: llmErr.type,
          delay:     Math.round(waitMs),
        });
        await delay(waitMs);
        retryCount++;
      }
    }

    // ── Fallback model ───────────────────────────────────────
    if (
      lastError &&
      FALLBACK_TRIGGER_TYPES.has(lastError.type) &&
      fallbackModel &&
      fallbackModel !== primaryModel
    ) {
      logger.warn({
        event:          'llm.fallback.triggered',
        callType,
        traceId,
        primaryModel,
        fallbackModel,
        primaryError:   lastError.type,
      });

      try {
        const result = await this.primaryProvider.call({
          ...callOptions,
          model: fallbackModel,
        });
        fallbackUsed = true;
        this.logSuccess({ result, callType, traceId, retryCount, fallbackUsed });
        return { ...result, fallbackUsed, retryCount, callType };
      } catch (fallbackErr) {
        const fallbackLlmErr = this.normalizeError(fallbackErr);
        logger.error({
          event:         'llm.fallback.failed',
          callType,
          traceId,
          fallbackModel,
          errorType:     fallbackLlmErr.type,
          errorMessage:  fallbackLlmErr.message,
        });
        // Throw the fallback error since that's the last attempt
        throw fallbackLlmErr;
      }
    }

    // ── All attempts exhausted ───────────────────────────────
    throw lastError ?? new LLMError('LLM call failed after all retries.', 'unknown');
  }

  private normalizeError(err: unknown): LLMError {
    if (err instanceof LLMError) return err;
    const msg = (err as Error)?.message || 'Unknown error';
    return new LLMError(msg, 'unknown', 502);
  }

  private logSuccess(params: {
    result:       OrchestratorResult | Awaited<ReturnType<LLMProvider['call']>>;
    callType:     string;
    traceId:      string | undefined;
    retryCount:   number;
    fallbackUsed: boolean;
  }): void {
    logger.info({
      event:        'llm.call.complete',
      callType:     params.callType,
      traceId:      params.traceId,
      model:        params.result.model,
      latencyMs:    params.result.latencyMs,
      totalTokens:  params.result.tokenDetails.totalTokens,
      cachedTokens: params.result.tokenDetails.cachedTokens,
      fallbackUsed: params.fallbackUsed,
      retryCount:   params.retryCount,
    });
  }
}

/** Application-wide singleton */
export const llmOrchestrator = new LLMOrchestrator(openAIProvider);
