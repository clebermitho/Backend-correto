export const CANONICAL_KB_SOURCE_URL = 'https://raw.githubusercontent.com/clebermitho/knowledge-base/main/base-conhecimento.json';

interface CanonicalKBInput {
  name?: string | null;
  sourceUrl?: string | null;
  content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUrl(url?: string | null): string {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

function isCanonicalKnowledgeBaseName(name?: string | null): boolean {
  const normalized = String(name || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return normalized.includes('base-conhecimento') || normalized.includes('knowledge-base');
}

function hasStringArrayField(obj: Record<string, unknown>, key: string): boolean {
  return Array.isArray(obj[key]) && (obj[key] as unknown[]).every((v: unknown) => typeof v === 'string');
}

function hasObjectField(obj: Record<string, unknown>, key: string): boolean {
  return isRecord(obj[key]);
}

export function isCanonicalKnowledgeBaseSourceUrl(sourceUrl?: string | null): boolean {
  return normalizeUrl(sourceUrl) === normalizeUrl(CANONICAL_KB_SOURCE_URL);
}

export function validateCanonicalKnowledgeBaseContent(content: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(content)) {
    return { valid: false, errors: ['content must be a JSON object'] };
  }

  if (!hasObjectField(content, 'project')) errors.push('project must be an object');
  if (!hasObjectField(content, 'behavior')) errors.push('behavior must be an object');
  if (!hasStringArrayField(content, 'core_rules')) errors.push('core_rules must be an array of strings');
  if (!hasObjectField(content, 'procedures')) errors.push('procedures must be an object');
  if (!hasObjectField(content, 'response_patterns')) errors.push('response_patterns must be an object');
  if (!hasObjectField(content, 'objections')) errors.push('objections must be an object');
  if (!hasObjectField(content, 'contacts')) errors.push('contacts must be an object');
  if (!hasStringArrayField(content, 'security_rules')) errors.push('security_rules must be an array of strings');
  if (!hasObjectField(content, 'fallback')) errors.push('fallback must be an object');
  if (!hasObjectField(content, 'response_model')) errors.push('response_model must be an object');

  return { valid: errors.length === 0, errors };
}

export function isCanonicalKnowledgeBaseContent(content: unknown): content is Record<string, unknown> {
  return validateCanonicalKnowledgeBaseContent(content).valid;
}

export function shouldValidateAsCanonicalKnowledgeBase(input: CanonicalKBInput): boolean {
  if (isCanonicalKnowledgeBaseSourceUrl(input.sourceUrl)) return true;

  if (isCanonicalKnowledgeBaseName(input.name)) {
    return true;
  }

  const content = input.content;
  if (!isRecord(content)) return false;
  return ['project', 'behavior', 'core_rules', 'procedures', 'response_model'].some(k => k in content);
}
