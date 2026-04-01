import logger from '../utils/logger';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CallOpenAIOptions {
  messages: OpenAIMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  timeoutMs?: number;
}

interface GenerateSuggestionsOptions {
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
}

interface GenerateChatReplyOptions {
  message: string;
  history?: OpenAIMessage[];
  systemPromptTemplate?: string;
  dbKnowledgeBases?: Record<string, unknown>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

function renderTemplate(template: string, vars?: Record<string, string>): string {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k: string) => {
    const v = vars?.[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

function clipText(value: unknown, maxChars: number): string {
  if (!value) return '';
  const s = String(value);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n[...truncado...]`;
}

// ── Retry com backoff exponencial ───────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, baseDelayMs = 500, label = 'openai' }: { retries?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message || '';
      const isRetryable =
        msg.includes('529') ||
        msg.includes('503') ||
        msg.includes('502') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT');

      if (!isRetryable || attempt === retries) break;

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      logger.warn({ event: `${label}.retry`, attempt, delay: Math.round(delay), err: msg });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── callOpenAI ───────────────────────────────────────────────
async function callOpenAI({
  messages,
  model       = process.env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature = 0.7,
  max_tokens  = 500,
  timeoutMs   = 30_000,
}: CallOpenAIOptions): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('Serviço de IA não configurado no servidor. Contate o administrador.') as Error & { statusCode: number };
    err.statusCode = 503;
    throw err;
  }

  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(OPENAI_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body:   JSON.stringify({ model, messages, temperature, max_tokens }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({})) as Record<string, unknown>;
        const errObj = errBody?.error as Record<string, unknown> | undefined;
        const msg = (errObj?.message as string) || `OpenAI HTTP ${response.status}`;
        const e = new Error(msg) as Error & { statusCode: number };
        e.statusCode = 502;
        throw e;
      }

      return response.json() as Promise<Record<string, unknown>>;
    } finally {
      clearTimeout(timer);
    }
  }, { label: 'openai.call' });
}

interface TokenDetails {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

// ── generateSuggestions ──────────────────────────────────────
async function generateSuggestions({
  context,
  question,
  category,
  topExamples    = [],
  avoidPatterns  = [],
  knowledgeBases = {},
  promptTemplate,
  model,
  temperature,
  maxTokens,
}: GenerateSuggestionsOptions): Promise<{
  suggestions: string[];
  latencyMs: number;
  model: string;
  tokensUsed: number | undefined;
  tokenDetails: TokenDetails;
}> {
  const kb = Object.fromEntries(
    Object.entries(knowledgeBases || {}).map(([k, v]) => [String(k).toLowerCase().trim(), v])
  );

  const avoidBlock = avoidPatterns.length > 0
    ? `\n🚫 EVITE estas palavras/frases reprovadas: ${avoidPatterns.map(p => `"${p}"`).join(', ')}`
    : '';

  const examplesBlock = topExamples.length > 0
    ? `\n📚 Exemplos aprovados para ${category}:\n${topExamples.map(e => `- ${e}`).join('\n')}`
    : '';

  const baseCorenRaw = kb.coren ?? kb['base_coren'] ?? kb['base coren'];
  const baseSistRaw  = kb.chat ?? kb.sistema ?? kb['base_sistema'] ?? kb['base sistema'];

  const baseCoren = baseCorenRaw ? clipText(JSON.stringify(baseCorenRaw), 12_000) : '(não carregada)';
  const baseChat  = baseSistRaw  ? clipText(JSON.stringify(baseSistRaw),  12_000) : '(não carregada)';

  const defaultPrompt = `Você é um assistente especializado do Coren (Conselho Regional de Enfermagem).

BASE COREN:
${baseCoren}

BASE SISTEMA:
${baseChat}

REGRAS:
1. Nunca chame o profissional de "cliente" — use "profissional".
2. Não invente leis, resoluções ou procedimentos.
3. Respostas curtas, claras, objetivas e com tom institucional.
4. Em débitos, sempre conduza para regularização.
5. Nunca confirme valores de parcelas — informe que verificará no sistema.
${avoidBlock}
${examplesBlock}

CONTEXTO DA CONVERSA:
${context}

PERGUNTA PRINCIPAL:
${question}

Gere exatamente 3 respostas profissionais e objetivas para esta situação.
Separe cada resposta por uma linha em branco.
NÃO use numeração nem prefixos como "Resposta 1:".`;

  const prompt = (promptTemplate && promptTemplate.trim().length > 0)
    ? renderTemplate(promptTemplate, {
        BASE_COREN:      baseCoren,
        BASE_SISTEMA:    baseChat,
        AVOID_BLOCK:     avoidBlock.trim(),
        EXAMPLES_BLOCK:  examplesBlock.trim(),
        CONTEXT:         clipText(context, 12_000),
        QUESTION:        question,
        CATEGORY:        category,
      }).trim()
    : defaultPrompt;

  const start = Date.now();

  const data = await callOpenAI({
    messages: [
      { role: 'system', content: 'Gerador de respostas institucionais do Coren' },
      { role: 'user',   content: prompt },
    ],
    model:       model || undefined,
    temperature: temperature ?? 0.7,
    max_tokens:  maxTokens ?? 500,
  });

  const latencyMs = Date.now() - start;
  const choices = data.choices as Array<{ message: { content: string } }>;
  const text = choices[0].message.content;
  const usage = data.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | undefined;

  const suggestions = text
    .split(/\n\s*\n/)
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 20)
    .slice(0, 3);

  // Garantir pelo menos 1 sugestão mesmo se parsing falhar
  if (suggestions.length === 0) {
    suggestions.push(text.trim().slice(0, 300));
  }

  logger.info({
    event:      'openai.suggestions_ok',
    category,
    count:      suggestions.length,
    latencyMs,
    tokens:     usage?.total_tokens,
    model:      data.model,
  });

  return {
    suggestions,
    latencyMs,
    model:      data.model as string,
    tokensUsed: usage?.total_tokens,
    tokenDetails: {
      promptTokens:     usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens:      usage?.total_tokens ?? 0,
      cachedTokens:     usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

// ── generateEmbedding — gera vetor para RAG ─────────────────
async function generateEmbedding(text: string): Promise<{ embedding: number[]; tokensUsed: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API Key não configurada.');

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000),
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errObj = errBody?.error as Record<string, unknown> | undefined;
    throw new Error((errObj?.message as string) || `OpenAI Embedding HTTP ${res.status}`);
  }

  const data = await res.json() as { data: Array<{ embedding: number[] }>; usage?: { total_tokens?: number } };
  return {
    embedding: data.data[0].embedding,
    tokensUsed: data.usage?.total_tokens ?? 0,
  };
}

// ── generateChatReply ────────────────────────────────────────
async function generateChatReply({
  message,
  history          = [],
  systemPromptTemplate = '',
  dbKnowledgeBases = {},
  model,
  temperature,
  maxTokens,
}: GenerateChatReplyOptions): Promise<{
  reply: string;
  latencyMs: number;
  model: string;
  tokensUsed: number | undefined;
  tokenDetails: TokenDetails;
}> {
  const kb = Object.fromEntries(
    Object.entries(dbKnowledgeBases || {}).map(([k, v]) => [String(k).toLowerCase().trim(), v])
  );

  const baseCorenObj = kb.coren ?? kb['base_coren'] ?? kb['base coren'];
  const baseSistObj  = kb.sistema ?? kb.chat ?? kb['base_sistema'] ?? kb['base sistema'];

  const baseCoren = baseCorenObj ? clipText(JSON.stringify(baseCorenObj), 12_000) : '(não carregada)';
  const baseSist  = baseSistObj  ? clipText(JSON.stringify(baseSistObj),  12_000) : '(não carregada)';

  const safeHistory = (Array.isArray(history) ? history : [])
    .map(m => ({
      role: m?.role === 'user' ? 'user' : 'assistant' as 'user' | 'assistant',
      content: String(m?.content || ''),
    }))
    .filter(m => m.content.trim() !== '')
    .slice(-10);

  const historyText = safeHistory
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  let systemContent = '';

  if (systemPromptTemplate && systemPromptTemplate.trim().length > 0) {
    systemContent = renderTemplate(systemPromptTemplate, {
      BASE_COREN:   baseCoren,
      BASE_SISTEMA: baseSist,
      MESSAGE:      message,
      HISTORY:      clipText(historyText, 6_000),
    }).trim();
  } else {
    systemContent = `Você é um assistente inteligente do Coren que ajuda operadores humanos.

BASE COREN:
${baseCoren}

BASE SISTEMA:
${baseSist}

IMPORTANTE: Responda de forma natural, clara e útil. Use emojis quando apropriado.`;
  }

  const messages: OpenAIMessage[] = [
    { role: 'system', content: systemContent },
    ...safeHistory.slice(-6),
    { role: 'user',   content: message },
  ];

  const start = Date.now();
  const data  = await callOpenAI({
    messages,
    model:       model || undefined,
    temperature: temperature ?? 0.8,
    max_tokens:  maxTokens ?? 600,
  });
  const latencyMs = Date.now() - start;

  const choices = data.choices as Array<{ message: { content: string } }>;
  const usage = data.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | undefined;

  logger.info({
    event:            'openai.chat_ok',
    latencyMs,
    tokens:           usage?.total_tokens,
    model:            data.model,
    hasKnowledgeBase: !!(baseCorenObj || baseSistObj),
    hasSystemPrompt:  systemPromptTemplate.trim().length > 0,
  });

  return {
    reply:      choices[0].message.content,
    latencyMs,
    model:      data.model as string,
    tokensUsed: usage?.total_tokens,
    tokenDetails: {
      promptTokens:     usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens:      usage?.total_tokens ?? 0,
      cachedTokens:     usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export { callOpenAI, generateSuggestions, generateChatReply, generateEmbedding };
