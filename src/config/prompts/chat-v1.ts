/**
 * Chat prompt — version 1.0.0
 *
 * Variables available in this template:
 *   {{BASE_COREN}}   - Content of the COREN knowledge base (truncated)
 *   {{BASE_SISTEMA}} - Content of the system/chat knowledge base (truncated)
 *   {{MESSAGE}}      - Current user message
 *   {{HISTORY}}      - Formatted conversation history
 */
export const chatPromptV1 = {
  id:        'chat',
  version:   '1.0.0',
  createdAt: '2026-04-02',
  owner:     'system',
  changelog: 'Initial version extracted from openai.ts hardcoded default',
  template: `Você é um assistente inteligente do Coren que ajuda operadores humanos.

BASE COREN:
{{BASE_COREN}}

BASE SISTEMA:
{{BASE_SISTEMA}}

IMPORTANTE: Responda de forma natural, clara e útil. Use emojis quando apropriado.`,
} as const;
