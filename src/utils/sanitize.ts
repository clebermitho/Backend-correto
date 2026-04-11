/**
 * Input sanitization utilities for AI flows.
 * Provides pragmatic protection against prompt injection attempts.
 *
 * Trade-off: regex-based detection is fast and has no external dependency,
 * but is not perfect — it reduces risk without eliminating it entirely.
 * A more complete solution would include LLM-based guardrails, out of scope here.
 */

// Patterns that are strong indicators of prompt injection attempts
const INJECTION_PATTERNS: RegExp[] = [
  // Classic "ignore previous instructions" variants
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|context|rules?)/i,
  /forget\s+(everything|all|previous|what)/i,
  // Role override attempts
  /\b(you are now|act as|pretend (to be|you are)|roleplay as|simulate being)\b/i,
  // Direct system prompt manipulation
  /(system\s*prompt|system\s*message|your instructions?).*?(is|are|should be|must be)/i,
  // Escape sequences or delimiter abuse
  /```\s*(system|instructions?)\s*```/i,
  // "DAN" and similar jailbreak patterns
  /\bDAN\b|\bjailbreak\b|\bunrestricted mode\b/i,
  // Instruction injection via encoded or special markers
  /<\|?(system|im_start|im_end|endofprompt)\|?>/i,
];

// Max allowed lengths for user-controlled AI inputs
const MAX_CONTEXT_LENGTH = 8_000;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_HISTORY_ENTRY_LENGTH = 2_000;
const MAX_HISTORY_ENTRIES = 20;

export interface SanitizationResult {
  value: string;
  flagged: boolean;
  reason?: string;
}

/**
 * Detects potential prompt injection in a text string.
 * Returns true if suspicious patterns are found.
 */
export function detectInjection(text: string): { flagged: boolean; reason?: string } {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, reason: `Suspicious pattern: ${pattern.source.slice(0, 60)}` };
    }
  }
  return { flagged: false };
}

/**
 * Sanitizes a context string for use in AI prompts.
 * Clips to max length and checks for injection.
 */
export function sanitizeContext(value: unknown): SanitizationResult {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  const clipped = text.length > MAX_CONTEXT_LENGTH
    ? text.slice(0, MAX_CONTEXT_LENGTH)
    : text;
  const { flagged, reason } = detectInjection(clipped);
  return { value: clipped, flagged, reason };
}

/**
 * Sanitizes a user question/message for use in AI prompts.
 */
export function sanitizeQuestion(value: unknown, maxLength = MAX_QUESTION_LENGTH): SanitizationResult {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  const clipped = text.length > maxLength ? text.slice(0, maxLength) : text;
  const { flagged, reason } = detectInjection(clipped);
  return { value: clipped, flagged, reason };
}

/**
 * Sanitizes a chat message.
 */
export function sanitizeMessage(value: unknown): SanitizationResult {
  return sanitizeQuestion(value, MAX_MESSAGE_LENGTH);
}

/**
 * Sanitizes a chat history array, clipping entries and validating structure.
 */
export function sanitizeHistory(
  history: Array<{ role: string; content: string }> | unknown
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(history)) return [];

  return history
    .slice(0, MAX_HISTORY_ENTRIES)
    .filter(
      (entry): entry is { role: string; content: string } =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.content === 'string' &&
        (entry.role === 'user' || entry.role === 'assistant')
    )
    .map(entry => ({
      role: entry.role as 'user' | 'assistant',
      content: entry.content.slice(0, MAX_HISTORY_ENTRY_LENGTH),
    }));
}
