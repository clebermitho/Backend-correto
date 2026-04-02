jest.mock('../../src/services/openai', () => ({
  callOpenAI:           jest.fn(),
  generateSuggestions:  jest.fn(),
  generateChatReply:    jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { generateSuggestions, generateChatReply } = require('../../src/services/openai');
const logger = require('../../src/utils/logger');
const {
  orchestrateSuggestions,
  orchestrateChat,
} = require('../../src/services/aiOrchestrator');

const MOCK_SUGGESTIONS_RESULT = {
  suggestions:   ['Sugestão 1', 'Sugestão 2', 'Sugestão 3'],
  latencyMs:     120,
  model:         'gpt-4o-mini',
  tokensUsed:    80,
  tokenDetails:  { promptTokens: 60, completionTokens: 20, totalTokens: 80, cachedTokens: 0 },
};

const MOCK_CHAT_RESULT = {
  reply:        'Resposta de teste.',
  latencyMs:    100,
  model:        'gpt-4o-mini',
  tokensUsed:   50,
  tokenDetails: { promptTokens: 40, completionTokens: 10, totalTokens: 50, cachedTokens: 0 },
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AI_FALLBACK_MODEL;
});

// ── orchestrateSuggestions ────────────────────────────────────

describe('orchestrateSuggestions', () => {
  it('returns result on first call success', async () => {
    generateSuggestions.mockResolvedValueOnce(MOCK_SUGGESTIONS_RESULT);

    const result = await orchestrateSuggestions({
      context:  'ctx',
      question: 'q',
      category: 'OUTROS',
    });

    expect(result.fallbackUsed).toBe(false);
    expect(result.data.suggestions).toEqual(MOCK_SUGGESTIONS_RESULT.suggestions);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.latencyMs).toBe(120);
    expect(result.tokensUsed).toBe(80);
    expect(typeof result.estimatedCostUsd).toBe('number');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.orchestrator.suggestions_ok', fallbackUsed: false })
    );
  });

  it('falls back to fallback model on timeout error', async () => {
    const timeoutErr = Object.assign(new Error('Request timeout: ETIMEDOUT'), { name: 'AbortError' });
    generateSuggestions
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(MOCK_SUGGESTIONS_RESULT);

    process.env.AI_FALLBACK_MODEL = 'gpt-3.5-turbo';

    const result = await orchestrateSuggestions({
      context:  'ctx',
      question: 'q',
      category: 'OUTROS',
      traceId:  'trace-123',
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe('timeout');
    expect(generateSuggestions).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.orchestrator.fallback', errorClass: 'timeout' })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.orchestrator.suggestions_ok', fallbackUsed: true })
    );
  });

  it('falls back on rate_limit (429) error', async () => {
    const rateLimitErr = Object.assign(new Error('429 rate limit exceeded'), { statusCode: 429 });
    generateSuggestions
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce(MOCK_SUGGESTIONS_RESULT);

    process.env.AI_FALLBACK_MODEL = 'gpt-4o-mini';
    // primary model set to something different to trigger fallback
    process.env.OPENAI_MODEL = 'gpt-4o';

    const result = await orchestrateSuggestions({
      context:  'ctx',
      question: 'q',
      category: 'OUTROS',
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe('rate_limit');
  });

  it('falls back on provider_error (502)', async () => {
    const providerErr = Object.assign(new Error('OpenAI HTTP 502'), { statusCode: 502 });
    generateSuggestions
      .mockRejectedValueOnce(providerErr)
      .mockResolvedValueOnce(MOCK_SUGGESTIONS_RESULT);

    process.env.AI_FALLBACK_MODEL = 'gpt-4o-mini';
    process.env.OPENAI_MODEL = 'gpt-4o';

    const result = await orchestrateSuggestions({
      context:  'ctx',
      question: 'q',
      category: 'OUTROS',
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe('provider_error');
  });

  it('does NOT fall back on no_api_key error', async () => {
    const noKeyErr = Object.assign(new Error('Serviço de IA não configurado no servidor. Contate o administrador.'), { statusCode: 503 });
    generateSuggestions.mockRejectedValueOnce(noKeyErr);

    await expect(orchestrateSuggestions({
      context:  'ctx',
      question: 'q',
      category: 'OUTROS',
    })).rejects.toThrow('Serviço de IA não configurado');

    expect(generateSuggestions).toHaveBeenCalledTimes(1);
  });

  it('throws when both primary and fallback fail', async () => {
    const err = Object.assign(new Error('rate limit'), { statusCode: 429 });
    generateSuggestions.mockRejectedValue(err);

    process.env.AI_FALLBACK_MODEL = 'gpt-4o-mini';
    process.env.OPENAI_MODEL = 'gpt-4o';

    await expect(orchestrateSuggestions({
      context:  'ctx',
      question: 'q',
      category: 'OUTROS',
    })).rejects.toThrow('rate limit');

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.orchestrator.fallback_failed' })
    );
  });

  it('includes estimatedCostUsd for known models', async () => {
    generateSuggestions.mockResolvedValueOnce({ ...MOCK_SUGGESTIONS_RESULT, model: 'gpt-4o-mini' });

    const result = await orchestrateSuggestions({
      context:  'ctx',
      question: 'q',
      category: 'OUTROS',
    });

    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('estimatedCostUsd is undefined for unknown model', async () => {
    generateSuggestions.mockResolvedValueOnce({ ...MOCK_SUGGESTIONS_RESULT, model: 'unknown-model' });

    const result = await orchestrateSuggestions({
      context:  'ctx',
      question: 'q',
      category: 'OUTROS',
    });

    expect(result.estimatedCostUsd).toBeUndefined();
  });
});

// ── orchestrateChat ───────────────────────────────────────────

describe('orchestrateChat', () => {
  it('returns result on first call success', async () => {
    generateChatReply.mockResolvedValueOnce(MOCK_CHAT_RESULT);

    const result = await orchestrateChat({ message: 'Olá', history: [] });

    expect(result.fallbackUsed).toBe(false);
    expect(result.data.reply).toBe('Resposta de teste.');
    expect(result.latencyMs).toBe(100);
  });

  it('falls back on timeout for chat', async () => {
    const timeoutErr = Object.assign(new Error('ETIMEDOUT'), { name: 'AbortError' });
    generateChatReply
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(MOCK_CHAT_RESULT);

    process.env.AI_FALLBACK_MODEL = 'gpt-3.5-turbo';
    process.env.OPENAI_MODEL = 'gpt-4o';

    const result = await orchestrateChat({ message: 'Olá', traceId: 'tid-1' });

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe('timeout');
  });
});
