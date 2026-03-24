const logger = require('../utils/logger');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function renderTemplate(template, vars) {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => {
    const v = vars?.[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

// ── Retry com backoff exponencial ───────────────────────────
async function withRetry(fn, { retries = 3, baseDelayMs = 500, label = 'openai' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRetryable = err.message?.includes('529') || // OpenAI overloaded
                          err.message?.includes('503') ||
                          err.message?.includes('502') ||
                          err.message?.includes('ECONNRESET') ||
                          err.message?.includes('ETIMEDOUT');

      if (!isRetryable || attempt === retries) break;

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      logger.warn({ event: `${label}.retry`, attempt, delay: Math.round(delay), err: err.message });
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
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('Serviço de IA não configurado no servidor. Contate o administrador.');
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
        const err = await response.json().catch(() => ({}));
        const msg = err?.error?.message || `OpenAI HTTP ${response.status}`;
        throw new Error(msg);
      }

      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }, { label: 'openai.call' });
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
}) {
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

  const baseCoren = baseCorenRaw ? JSON.stringify(baseCorenRaw, null, 2) : '(não carregada)';
  const baseChat  = baseSistRaw  ? JSON.stringify(baseSistRaw,  null, 2) : '(não carregada)';

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
        BASE_COREN:     baseCoren,
        BASE_SISTEMA:  baseChat,
        AVOID_BLOCK:   avoidBlock.trim(),
        EXAMPLES_BLOCK: examplesBlock.trim(),
        CONTEXT:       context,
        QUESTION:      question,
        CATEGORY:      category,
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
  const text = data.choices[0].message.content;

  const suggestions = text
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 20)
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
    tokens:     data.usage?.total_tokens,
    model:      data.model,
  });

  return {
    suggestions,
    latencyMs,
    model:      data.model,
    tokensUsed: data.usage?.total_tokens,
  };
}

// ── generateEmbedding — gera vetor para RAG ─────────────────
async function generateEmbedding(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API Key não configurada.');

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000), // limite seguro p/ tokens
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI Embedding HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

// ── generateChatReply ────────────────────────────────────────
async function generateChatReply({
  message,
  history          = [],
  context          = '',
  knowledge        = {},
  systemPrompt     = '',
  systemPromptTemplate = '',
  dbKnowledgeBases = {},
  model,
  temperature,
  maxTokens,
}) {
  const kb = Object.fromEntries(
    Object.entries(dbKnowledgeBases || {}).map(([k, v]) => [String(k).toLowerCase().trim(), v])
  );

  const baseCorenObj = knowledge?.coren ?? kb.coren ?? kb['base_coren'] ?? kb['base coren'];
  const baseSistObj  = knowledge?.sistema ?? kb.sistema ?? kb.chat ?? kb['base_sistema'] ?? kb['base sistema'];

  const baseCoren = baseCorenObj ? JSON.stringify(baseCorenObj, null, 2) : '(não carregada)';
  const baseSist  = baseSistObj  ? JSON.stringify(baseSistObj,  null, 2) : '(não carregada)';

  const historyText = history
    .slice(-10)
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  let systemContent = '';

  if (systemPromptTemplate && systemPromptTemplate.trim().length > 0) {
    systemContent = renderTemplate(systemPromptTemplate, {
      BASE_COREN:    baseCoren,
      BASE_SISTEMA: baseSist,
      CONTEXT:      context,
      MESSAGE:      message,
      HISTORY:      historyText,
    }).trim();
  } else if (systemPrompt && systemPrompt.trim().length > 50) {
    systemContent = systemPrompt;
  } else {
    systemContent = `Você é um assistente inteligente do Coren que ajuda operadores humanos.

BASE COREN:
${baseCoren}

BASE SISTEMA:
${baseSist}

IMPORTANTE: Responda de forma natural, clara e útil. Use emojis quando apropriado.`;
  }

  // Montar mensagem do usuário com contexto do chat (se existir)
  const userContent = context && context.trim().length > 0
    ? `CONTEXTO DO CHAT:\n${context}\n\nPERGUNTA DO OPERADOR:\n${message}`
    : message;

  const messages = [
    { role: 'system', content: systemContent },
    ...history.slice(-6),    // últimas 6 trocas para continuidade da conversa
    { role: 'user',   content: userContent },
  ];

  const start = Date.now();
  const data  = await callOpenAI({
    messages,
    model:       model || undefined,
    temperature: temperature ?? 0.8,
    max_tokens:  maxTokens ?? 600,
  });
  const latencyMs = Date.now() - start;

  logger.info({
    event:    'openai.chat_ok',
    latencyMs,
    tokens:   data.usage?.total_tokens,
    model:    data.model,
    hasCtx:   context.length > 0,
    hasKnow:  !!(knowledge?.coren || knowledge?.sistema),
    hasSysP:  systemPrompt.length > 50,
  });

  return {
    reply:      data.choices[0].message.content,
    latencyMs,
    tokensUsed: data.usage?.total_tokens,
  };
}

module.exports = { callOpenAI, generateSuggestions, generateChatReply };
