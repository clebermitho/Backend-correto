/**
 * LLM Service — public API
 *
 * Single import point for all LLM-related functionality.
 */

export type {
  LLMMessage,
  LLMCallOptions,
  LLMResult,
  LLMTokenDetails,
  LLMErrorType,
  LLMProvider,
  OrchestratorOptions,
  OrchestratorResult,
} from './types';
export { LLMError } from './types';
export { LLMOrchestrator, llmOrchestrator } from './orchestrator';
export { OpenAIProvider, openAIProvider } from './providers/openai';
