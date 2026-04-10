jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { generateSuggestions, generateChatReply } = require('../../src/services/openai');

function canonicalKnowledgeBase() {
  return {
    project: { name: 'Coren' },
    behavior: { tone: 'institucional' },
    core_rules: ['Não inventar procedimentos'],
    intelligence: { mode: 'assistente' },
    procedures: { regularizacao: ['passo 1', 'passo 2'] },
    response_patterns: { saudacao: 'Olá!' },
    objections: { prazo: ['resposta padrão'] },
    contacts: { whatsapp: '11999999999' },
    security_rules: ['Não vazar dados'],
    fallback: { default: 'encaminhar para humano' },
    response_model: { style: 'claro' },
  };
}

function openAiResponse(text) {
  return {
    ok: true,
    json: async () => ({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  };
}

describe('openai unified knowledge context', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue(
      openAiResponse('Sugestão A\n\nSugestão B\n\nSugestão C')
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('builds suggestions prompt using unified canonical context', async () => {
    await generateSuggestions({
      context: 'Atendimento em andamento',
      question: 'Qual a melhor resposta?',
      category: 'DUVIDA',
      knowledgeBases: { 'base-conhecimento': canonicalKnowledgeBase() },
    });

    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const prompt = requestBody.messages[1].content;

    expect(prompt).toContain('BASE DE CONHECIMENTO UNIFICADA');
    expect(prompt).toContain('REGRAS CENTRAIS');
    expect(prompt).toContain('Não inventar procedimentos');
  });

  it('keeps compatibility for legacy placeholders while supporting KNOWLEDGE_CONTEXT', async () => {
    await generateSuggestions({
      context: 'Contexto',
      question: 'Pergunta',
      category: 'OUTROS',
      knowledgeBases: { 'base-conhecimento': canonicalKnowledgeBase() },
      promptTemplate: 'CTX={{KNOWLEDGE_CONTEXT}}\nLEGACY1={{BASE_COREN}}\nLEGACY2={{BASE_SISTEMA}}',
    });

    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const prompt = requestBody.messages[1].content;

    expect(prompt).toContain('CTX=');
    expect(prompt).toContain('LEGACY1=');
    expect(prompt).toContain('LEGACY2=');
    expect(prompt).toContain('REGRAS CENTRAIS');
  });

  it('uses unified context in chat fallback system prompt', async () => {
    global.fetch.mockResolvedValueOnce(openAiResponse('Resposta do chat'));

    await generateChatReply({
      message: 'Oi',
      history: [],
      dbKnowledgeBases: { 'base-conhecimento': canonicalKnowledgeBase() },
    });

    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const systemPrompt = requestBody.messages[0].content;

    expect(systemPrompt).toContain('BASE DE CONHECIMENTO UNIFICADA');
    expect(systemPrompt).toContain('REGRAS CENTRAIS');
  });
});
