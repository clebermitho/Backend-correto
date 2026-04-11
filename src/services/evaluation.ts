/**
 * Quality Evaluation Service — foundation for offline and online evaluation.
 *
 * Phase 2 deliverable: minimum viable foundation.
 * - Online signals: collected via this service (latency, user feedback, fallback usage)
 * - Offline evaluation: interface + reference dataset loader (datasets live in eval/)
 *
 * Trade-off: signals are persisted to the existing `usage_events` table
 * (eventType = 'eval.*') to avoid new migrations. A dedicated `eval_runs` table
 * is the next step when we need querying/dashboards.
 */

import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

// ── Online signal types ──────────────────────────────────────

export type EvalSignalType =
  | 'suggestion.accepted'
  | 'suggestion.rejected'
  | 'chat.thumbs_up'
  | 'chat.thumbs_down'
  | 'ai.fallback_used'
  | 'ai.timeout'
  | 'ai.rate_limit';

export interface OnlineSignal {
  organizationId: string;
  userId?: string;
  signal: EvalSignalType;
  /** Correlates with the traceId / requestId of the original AI call */
  traceId?: string;
  /** Additional context: model used, latencyMs, category, etc. */
  metadata?: Record<string, unknown>;
}

/**
 * Records an online quality signal (non-blocking — does not throw).
 * Signals feed dashboards, trend detection, and future model selection.
 */
export async function recordSignal(s: OnlineSignal): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: {
        organizationId: s.organizationId,
        userId:         s.userId ?? null,
        eventType:      `eval.${s.signal}`,
        payload:        {
          traceId:  s.traceId,
          signal:   s.signal,
          ...s.metadata,
        },
      },
    });
  } catch (err) {
    logger.warn({
      event:  'eval.record_signal_error',
      signal: s.signal,
      orgId:  s.organizationId,
      err:    (err as Error).message,
    });
  }
}

// ── Offline evaluation types ─────────────────────────────────

export interface EvalCase {
  id: string;
  /** Input sent to the AI (context + question for suggestions, message for chat) */
  input: Record<string, unknown>;
  /** Reference / expected output or criteria */
  expected: {
    /** Keywords that MUST appear in output (any of them) */
    mustContain?: string[];
    /** Keywords that must NOT appear in output */
    mustNotContain?: string[];
    /** Minimum character length of a valid response */
    minLength?: number;
  };
  /** Optional human-curated ideal answer (for scoring) */
  idealAnswer?: string;
  /** Scenario tag (e.g. "quota_exceeded", "nursing_regulation") */
  tags?: string[];
}

export interface EvalResult {
  caseId: string;
  passed: boolean;
  score: number; // 0–1
  details: string[];
  latencyMs: number;
  model: string;
}

export interface EvalRunSummary {
  runId: string;
  timestamp: string;
  totalCases: number;
  passed: number;
  failed: number;
  avgScore: number;
  avgLatencyMs: number;
  results: EvalResult[];
}

/**
 * Evaluates a single AI response against an eval case criteria.
 * This is the core scoring function — deterministic, no LLM needed.
 */
export function scoreResponse(evalCase: EvalCase, response: string, latencyMs: number, model: string): EvalResult {
  const details: string[] = [];
  let score = 1.0;

  const { mustContain, mustNotContain, minLength } = evalCase.expected;

  if (minLength && response.length < minLength) {
    score -= 0.3;
    details.push(`Response too short: ${response.length} < ${minLength}`);
  }

  if (mustContain?.length) {
    const lower = response.toLowerCase();
    for (const kw of mustContain) {
      if (!lower.includes(kw.toLowerCase())) {
        score -= 0.2;
        details.push(`Missing expected keyword: "${kw}"`);
      }
    }
  }

  if (mustNotContain?.length) {
    const lower = response.toLowerCase();
    for (const kw of mustNotContain) {
      if (lower.includes(kw.toLowerCase())) {
        score -= 0.25;
        details.push(`Contains forbidden keyword: "${kw}"`);
      }
    }
  }

  const finalScore = Math.max(0, Math.min(1, score));

  return {
    caseId:    evalCase.id,
    passed:    finalScore >= 0.7,
    score:     Math.round(finalScore * 100) / 100,
    details,
    latencyMs,
    model,
  };
}

/**
 * Summarises a set of eval results into a run report.
 */
export function summariseRun(results: EvalResult[]): Omit<EvalRunSummary, 'runId' | 'timestamp'> {
  const passed = results.filter(r => r.passed).length;
  const avgScore = results.length > 0
    ? results.reduce((s, r) => s + r.score, 0) / results.length
    : 0;
  const avgLatencyMs = results.length > 0
    ? results.reduce((s, r) => s + r.latencyMs, 0) / results.length
    : 0;

  return {
    totalCases:   results.length,
    passed,
    failed:       results.length - passed,
    avgScore:     Math.round(avgScore * 1000) / 1000,
    avgLatencyMs: Math.round(avgLatencyMs),
    results,
  };
}

/**
 * Logs an eval run summary (non-blocking).
 * In the next phase this would persist to an `eval_runs` table.
 */
export function logEvalRun(summary: EvalRunSummary): void {
  logger.info({
    event:        'eval.run_complete',
    runId:        summary.runId,
    totalCases:   summary.totalCases,
    passed:       summary.passed,
    failed:       summary.failed,
    avgScore:     summary.avgScore,
    avgLatencyMs: summary.avgLatencyMs,
    passRate:     summary.totalCases > 0
      ? Math.round((summary.passed / summary.totalCases) * 100)
      : 0,
  });
}
