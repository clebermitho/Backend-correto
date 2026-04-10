const {
  CANONICAL_KB_SOURCE_URL,
  isCanonicalKnowledgeBaseSourceUrl,
  validateCanonicalKnowledgeBaseContent,
  shouldValidateAsCanonicalKnowledgeBase,
} = require('../../src/utils/knowledgeBaseContract');

function validCanonicalContent() {
  return {
    project: { name: 'Coren' },
    behavior: { tone: 'institucional' },
    core_rules: ['Regra 1'],
    intelligence: { mode: 'assistente' },
    procedures: { cobranca: ['passo 1'] },
    response_patterns: { default: 'ok' },
    objections: { preco: ['resposta'] },
    contacts: { telefone: '0800' },
    security_rules: ['Não inventar dados'],
    fallback: { default: 'encaminhar' },
    response_model: { style: 'curto' },
  };
}

describe('knowledgeBaseContract', () => {
  it('recognizes canonical source URL', () => {
    expect(isCanonicalKnowledgeBaseSourceUrl(CANONICAL_KB_SOURCE_URL)).toBe(true);
    expect(isCanonicalKnowledgeBaseSourceUrl('https://example.com/base.json')).toBe(false);
  });

  it('validates minimal canonical contract structure', () => {
    const valid = validateCanonicalKnowledgeBaseContent(validCanonicalContent());
    expect(valid.valid).toBe(true);
    expect(valid.errors).toEqual([]);

    const invalid = validateCanonicalKnowledgeBaseContent({ project: {} });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  it('flags entries that should be treated as canonical', () => {
    expect(shouldValidateAsCanonicalKnowledgeBase({
      name: 'base-conhecimento',
      sourceUrl: null,
      content: {},
    })).toBe(true);

    expect(shouldValidateAsCanonicalKnowledgeBase({
      name: 'coren',
      sourceUrl: 'https://example.com/legacy.json',
      content: { anything: true },
    })).toBe(false);

    expect(shouldValidateAsCanonicalKnowledgeBase({
      name: 'qualquer',
      sourceUrl: null,
      content: { project: {}, behavior: {} },
    })).toBe(true);
  });
});
