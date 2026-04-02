/**
 * LLM Service — Public types
 *
 * Defines the contracts used across the LLM orchestration layer.
 * Providers (OpenAI, Anthropic, etc.) implement `LLMProvider`.
 * The orchestrator accepts `LLMCallOptions` and returns `LLMResult`.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Options accepted by any LLM provider */
export interface LLMCallOptions {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Token breakdown returned by a provider call */
export interface LLMTokenDetails {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

/** Successful result of a single LLM call */
export interface LLMResult {
  text: string;
  model: string;
  latencyMs: number;
  tokensUsed: number;
  tokenDetails: LLMTokenDetails;
}

/** Error categories used to drive fallback policy */
export type LLMErrorType =
  | 'timeout'
  | 'rate_limit'
  | 'provider_error'
  | 'context_too_long'
  | 'not_configured'
  | 'unknown';

/** Structured LLM error carrying the error category */
export class LLMError extends Error {
  readonly type: LLMErrorType;
  readonly statusCode: number;

  constructor(message: string, type: LLMErrorType, statusCode = 502) {
    super(message);
    this.name = 'LLMError';
    this.type  = type;
    this.statusCode = statusCode;
  }
}

/** Contract that every provider adapter must satisfy */
export interface LLMProvider {
  readonly name: string;
  call(options: LLMCallOptions): Promise<LLMResult>;
}

/** Options accepted by the orchestrator */
export interface OrchestratorOptions extends LLMCallOptions {
  /** Secondary provider/model used when the primary fails */
  fallbackModel?: string;
  /** Maximum number of attempts (across primary + retries before fallback) */
  maxRetries?: number;
  /** Caller context for logging */
  callType?: 'suggestions' | 'chat' | 'embedding';
  /** TraceId for correlation */
  traceId?: string;
}

/** Orchestrator result — extends LLMResult with observability fields */
export interface OrchestratorResult extends LLMResult {
  fallbackUsed: boolean;
  retryCount: number;
  callType?: string;
}
