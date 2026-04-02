/**
 * OpenAI LLM Provider Adapter
 *
 * Wraps the existing openai.ts service to satisfy the LLMProvider interface.
 * This allows the orchestrator to swap providers without changing call sites.
 *
 * Trade-off: thin adapter — all retry/timeout logic lives in the orchestrator,
 * not here, to avoid double-retry and keep this class easy to test.
 */

import type { LLMCallOptions, LLMProvider, LLMResult, LLMTokenDetails } from '../types';
import { LLMError } from '../types';
import logger from '../../../utils/logger';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  async call(options: LLMCallOptions): Promise<LLMResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new LLMError(
        'Serviço de IA não configurado no servidor. Contate o administrador.',
        'not_configured',
        503,
      );
    }

    const {
      messages,
      model     = process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature = 0.7,
      maxTokens   = 500,
      timeoutMs   = 30_000,
    } = options;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const start = Date.now();

    try {
      const response = await fetch(OPENAI_CHAT_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body:   JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({})) as Record<string, unknown>;
        const errObj  = errBody?.error as Record<string, unknown> | undefined;
        const msg     = (errObj?.message as string) || `OpenAI HTTP ${response.status}`;

        if (response.status === 429) {
          throw new LLMError(msg, 'rate_limit', 429);
        }
        if (response.status === 400 && msg.toLowerCase().includes('context_length')) {
          throw new LLMError(msg, 'context_too_long', 400);
        }
        throw new LLMError(msg, 'provider_error', 502);
      }

      const data = await response.json() as Record<string, unknown>;
      const latencyMs = Date.now() - start;

      const choices = data.choices as Array<{ message: { content: string } }>;
      const text    = choices[0]?.message?.content ?? '';

      const usage = data.usage as {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      } | undefined;

      const tokenDetails: LLMTokenDetails = {
        promptTokens:     usage?.prompt_tokens     ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens:      usage?.total_tokens      ?? 0,
        cachedTokens:     usage?.prompt_tokens_details?.cached_tokens ?? 0,
      };

      return {
        text,
        model:      data.model as string,
        latencyMs,
        tokensUsed: tokenDetails.totalTokens,
        tokenDetails,
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new LLMError('OpenAI request timed out.', 'timeout', 504);
      }
      if (err instanceof LLMError) throw err;

      const msg = (err as Error).message || 'Unknown OpenAI error';
      if (
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED')
      ) {
        throw new LLMError(msg, 'timeout', 504);
      }
      throw new LLMError(msg, 'provider_error', 502);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Singleton — re-use across requests */
export const openAIProvider = new OpenAIProvider();

logger.debug({ event: 'llm.provider.registered', name: 'openai' });
