/**
 * Prompt Registry
 *
 * Manages versioned prompt templates for the application.
 *
 * In Phase 1 (this PR): prompts are defined as static TypeScript constants.
 * In Phase 2: this registry will also load active PromptVersion records from the
 * database, allowing admins to publish new versions without redeployment.
 *
 * Design:
 * - `getSystemPrompt(name, orgOverride?)` returns the rendered system prompt for a
 *   given name, preferring an org-level override over the system default.
 * - Templates use `{{VARIABLE}}` syntax (uppercase only) for substitution.
 * - Unknown variables are replaced with empty string (silent — never throw on missing vars).
 */

import { suggestionPromptV1 } from './suggestions-v1';
import { chatPromptV1 }        from './chat-v1';

export interface PromptEntry {
  id:        string;
  version:   string;
  createdAt: string;
  owner:     string;
  changelog: string;
  template:  string;
}

/** All built-in system prompts, indexed by name */
const SYSTEM_PROMPTS: Record<string, PromptEntry> = {
  suggestions: suggestionPromptV1,
  chat:        chatPromptV1,
};

/**
 * Render a template string, substituting `{{VAR}}` placeholders.
 * Missing variables are replaced with an empty string.
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Returns the PromptEntry for a given name.
 * `orgTemplate` (from settings['prompt.suggestions'] etc.) acts as an override
 * for backward compatibility until orgs migrate to PromptVersion records.
 */
export function getPromptEntry(
  name: string,
  orgTemplate?: string,
): PromptEntry {
  if (orgTemplate && orgTemplate.trim().length > 0) {
    return {
      id:        name,
      version:   'org-override',
      createdAt: new Date().toISOString(),
      owner:     'org-admin',
      changelog: 'Organization-level override from settings',
      template:  orgTemplate,
    };
  }
  const entry = SYSTEM_PROMPTS[name];
  if (!entry) {
    throw new Error(`Prompt template not found: ${name}`);
  }
  return entry;
}

/** List all registered system prompt names */
export function listSystemPrompts(): string[] {
  return Object.keys(SYSTEM_PROMPTS);
}
