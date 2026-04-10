/**
 * Chat prompt — version 1.1.0
 *
 * Variables available in this template:
 *   {{KNOWLEDGE_CONTEXT}} - Unified canonical knowledge base context
 *   {{BASE_COREN}}        - Legacy compatibility fallback context
 *   {{BASE_SISTEMA}}      - Legacy compatibility fallback context
 *   {{MESSAGE}}      - Current user message
 *   {{HISTORY}}      - Formatted conversation history
 */
export const chatPromptV1 = {
  id:        'chat',
  version:   '1.1.0',
  createdAt: '2026-04-02',
  owner:     'system',
  changelog: 'Migrated to unified KNOWLEDGE_CONTEXT with legacy placeholder compatibility',
  template: `Você é um assistente inteligente do Coren que ajuda operadores humanos.

BASE DE CONHECIMENTO UNIFICADA:
{{KNOWLEDGE_CONTEXT}}

IMPORTANTE: Responda de forma natural, clara e útil. Use emojis quando apropriado.`,
} as const;
