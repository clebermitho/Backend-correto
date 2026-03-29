import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

const DEFAULT_COST_PER_TOKEN = 0.000002; // approximate GPT-4o-mini rate

function sinceDefault30Days(): Date {
  return new Date(Date.now() - 30 * 24 * 3600 * 1000);
}

// ── GET /api/analytics/overview ──────────────────────────────
router.get(
  '/overview',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = req.organizationId!;
      const now   = new Date();

      const [totalApiCalls, org, totalUsers, activeSessions] = await Promise.all([
        prisma.usageEvent.count({
          where: { organizationId: orgId, eventType: { startsWith: 'ai.' } },
        }),
        prisma.organization.findUnique({
          where:  { id: orgId },
          select: { usedTokens: true, monthlyQuota: true },
        }),
        prisma.user.count({ where: { organizationId: orgId } }),
        prisma.session.findMany({
          where:    { isRevoked: false, expiresAt: { gt: now }, user: { organizationId: orgId } },
          select:   { userId: true },
          distinct: ['userId'],
        }),
      ]);

      const totalTokensUsed   = org?.usedTokens   ?? 0;
      const monthlyQuota      = org?.monthlyQuota  ?? 0;
      const quotaUsagePercent = monthlyQuota > 0
        ? Math.round((totalTokensUsed / monthlyQuota) * 10000) / 100
        : 0;
      const estimatedCostUSD  = totalTokensUsed * DEFAULT_COST_PER_TOKEN;

      res.json({
        totalApiCalls,
        totalTokensUsed,
        monthlyQuota,
        quotaUsagePercent,
        estimatedCostUSD,
        totalUsers,
        activeUsers: activeSessions.length,
      });
    } catch (err) { next(err); }
  }
);

// ── GET /api/analytics/usage-per-user ────────────────────────
router.get(
  '/usage-per-user',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { since: sinceRaw } = z.object({
        since: z.string().datetime({ offset: true }).optional(),
      }).parse(req.query);

      const sinceDate = sinceRaw ? new Date(sinceRaw) : sinceDefault30Days();
      const orgId     = req.organizationId!;

      type RowType = {
        userId: string;
        name: string;
        email: string | null;
        totalRequests: bigint;
        totalTokens: bigint;
      };

      const rows = await prisma.$queryRaw<RowType[]>`
        SELECT
          u.id            AS "userId",
          u.name,
          u.email,
          COUNT(ue.id)    AS "totalRequests",
          COALESCE(SUM((ue.payload->>'tokensUsed')::numeric), 0)::bigint AS "totalTokens"
        FROM users u
        LEFT JOIN usage_events ue
          ON ue."userId"     = u.id
         AND ue."eventType"  LIKE 'ai.%'
         AND ue."createdAt" >= ${sinceDate}
        WHERE u."organizationId" = ${orgId}
        GROUP BY u.id, u.name, u.email
        ORDER BY "totalRequests" DESC
      `;

      const result = rows.map(r => {
        const totalTokens = Number(r.totalTokens);
        return {
          userId:        r.userId,
          name:          r.name,
          email:         r.email,
          totalRequests: Number(r.totalRequests),
          totalTokens,
          estimatedCost: totalTokens * DEFAULT_COST_PER_TOKEN,
        };
      });

      res.json({ users: result, since: sinceDate.toISOString() });
    } catch (err) { next(err); }
  }
);

// ── GET /api/analytics/usage-over-time ───────────────────────
router.get(
  '/usage-over-time',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { since: sinceRaw, granularity } = z.object({
        since:       z.string().datetime({ offset: true }).optional(),
        granularity: z.enum(['day', 'week']).default('day'),
      }).parse(req.query);

      const sinceDate = sinceRaw ? new Date(sinceRaw) : sinceDefault30Days();
      const orgId     = req.organizationId!;
      const trunc     = granularity === 'week' ? 'week' : 'day';

      type TimeRow = {
        date: Date;
        requests: bigint;
        tokens: bigint;
      };

      // Using a raw template literal that composes the trunc string safely
      const rows = trunc === 'week'
        ? await prisma.$queryRaw<TimeRow[]>`
            SELECT
              DATE_TRUNC('week', "createdAt")  AS date,
              COUNT(*)                          AS requests,
              COALESCE(SUM((payload->>'tokensUsed')::numeric), 0)::bigint AS tokens
            FROM usage_events
            WHERE "organizationId" = ${orgId}
              AND "eventType" LIKE 'ai.%'
              AND "createdAt" >= ${sinceDate}
            GROUP BY DATE_TRUNC('week', "createdAt")
            ORDER BY date ASC
          `
        : await prisma.$queryRaw<TimeRow[]>`
            SELECT
              DATE_TRUNC('day', "createdAt")   AS date,
              COUNT(*)                          AS requests,
              COALESCE(SUM((payload->>'tokensUsed')::numeric), 0)::bigint AS tokens
            FROM usage_events
            WHERE "organizationId" = ${orgId}
              AND "eventType" LIKE 'ai.%'
              AND "createdAt" >= ${sinceDate}
            GROUP BY DATE_TRUNC('day', "createdAt")
            ORDER BY date ASC
          `;

      const result = rows.map(r => {
        const tokens = Number(r.tokens);
        return {
          date:     r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
          requests: Number(r.requests),
          tokens,
          cost:     tokens * DEFAULT_COST_PER_TOKEN,
        };
      });

      res.json({ data: result, since: sinceDate.toISOString(), granularity });
    } catch (err) { next(err); }
  }
);

export default router;
