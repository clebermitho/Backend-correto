/**
 * Prompt Registry — foundation for versioned prompts and A/B experimentation.
 *
 * Architecture decision:
 * Prompts are stored in the existing `settings` table (key = `prompt.v:<id>:<version>`)
 * so no schema migration is required for this phase. The registry provides a typed
 * abstraction that a future phase can back with a dedicated `prompts` table without
 * changing call sites.
 *
 * Trade-off: using the settings table avoids migrations at the cost of less strict
 * schema enforcement. Acceptable for this phase; a dedicated model is the next step.
 */

import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

export interface PromptEntry {
  /** Stable identifier for the prompt (e.g. "suggestions.v1", "chat.coren") */
  id: string;
  /** Semantic version string */
  version: string;
  /** Team / person responsible for this prompt */
  owner: string;
  /** The prompt template content (may include {{VARIABLE}} placeholders) */
  template: string;
  /** What changed in this version */
  changelog?: string;
  /** When this version was created/updated */
  updatedAt: Date;
}

export interface PromptRegistryEntry {
  id: string;
  version: string;
  owner: string;
  template: string;
  changelog?: string;
  updatedAt: Date;
}

// In-memory cache (per process) to avoid repeated DB lookups for the same key
const localCache = new Map<string, { entry: PromptRegistryEntry; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function settingKey(id: string, version: string): string {
  return `prompt.v:${id}:${version}`;
}

function parseStoredValue(raw: unknown): Omit<PromptRegistryEntry, 'id' | 'version'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.template !== 'string') return null;
  return {
    owner:     typeof r.owner === 'string' ? r.owner : 'system',
    template:  r.template,
    changelog: typeof r.changelog === 'string' ? r.changelog : undefined,
    updatedAt: r.updatedAt ? new Date(r.updatedAt as string) : new Date(),
  };
}

/**
 * Retrieves a versioned prompt from the registry.
 * Falls back to `undefined` if not found — callers should have a hardcoded default.
 */
export async function getPrompt(
  organizationId: string,
  id: string,
  version = 'latest'
): Promise<PromptRegistryEntry | undefined> {
  const cacheKey = `${organizationId}:${id}:${version}`;
  const cached = localCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.entry;
  }

  try {
    const key = settingKey(id, version);
    const setting = await prisma.setting.findUnique({
      where: { organizationId_key: { organizationId, key } },
      select: { value: true, updatedAt: true },
    });

    if (!setting) return undefined;

    const parsed = parseStoredValue(setting.value);
    if (!parsed) return undefined;

    const entry: PromptRegistryEntry = {
      id,
      version,
      ...parsed,
      updatedAt: setting.updatedAt,
    };

    localCache.set(cacheKey, { entry, expiresAt: Date.now() + CACHE_TTL_MS });
    return entry;
  } catch (err) {
    logger.warn({
      event:   'promptRegistry.fetch_error',
      id,
      version,
      orgId:   organizationId,
      err:     (err as Error).message,
    });
    return undefined;
  }
}

/**
 * Persists a versioned prompt to the registry.
 * If version already exists, it is overwritten (use a new version string for immutable history).
 */
export async function setPrompt(
  organizationId: string,
  entry: Omit<PromptEntry, 'updatedAt'>
): Promise<void> {
  const key = settingKey(entry.id, entry.version);
  const value = {
    owner:     entry.owner,
    template:  entry.template,
    changelog: entry.changelog,
    updatedAt: new Date().toISOString(),
  };

  await prisma.setting.upsert({
    where:  { organizationId_key: { organizationId, key } },
    create: { organizationId, key, value },
    update: { value },
  });

  // Invalidate local cache
  const cacheKey = `${organizationId}:${entry.id}:${entry.version}`;
  localCache.delete(cacheKey);
  // Also invalidate 'latest' pointer if this is the latest version
  localCache.delete(`${organizationId}:${entry.id}:latest`);

  logger.info({
    event:   'promptRegistry.set',
    id:      entry.id,
    version: entry.version,
    owner:   entry.owner,
    orgId:   organizationId,
  });
}

/**
 * Lists all registered prompt versions for an org.
 * Returns lightweight metadata (no template content) for listing/admin UI.
 */
export async function listPrompts(
  organizationId: string
): Promise<Array<{ id: string; version: string; owner: string; changelog?: string; updatedAt: Date }>> {
  try {
    const rows = await prisma.setting.findMany({
      where: {
        organizationId,
        key: { startsWith: 'prompt.v:' },
      },
      select: { key: true, value: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });

    return rows.flatMap(row => {
      const parts = row.key.split(':');
      const [id, version] = parts.slice(2);
      if (!id || !version) return [];
      const parsed = parseStoredValue(row.value);
      if (!parsed) return [];
      return [{
        id,
        version,
        owner:     parsed.owner,
        changelog: parsed.changelog,
        updatedAt: row.updatedAt,
      }];
    });
  } catch (err) {
    logger.warn({ event: 'promptRegistry.list_error', orgId: organizationId, err: (err as Error).message });
    return [];
  }
}

/** Clears the in-process cache (useful in tests). */
export function clearPromptCache(): void {
  localCache.clear();
}
