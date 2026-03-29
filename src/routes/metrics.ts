import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// GET /api/metrics/summary — visão geral para o admin
router.get('/summary', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orgId = req.organizationId!;
    const since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 30 * 24 * 3600 * 1000);

    const [
      totalUsers,
      activeUsers,
      totalSuggestions,
      totalFeedback,
      approvedFeedback,
      rejectedFeedback,
      totalEvents,
      eventsByType,
      topUsers,
      totalTemplates,
      learnedTemplates,
      avgLatencyRaw,
    ] = await Promise.all([
      prisma.user.count({ where: { organizationId: orgId } }),

      prisma.user.count({
        where: { organizationId: orgId, lastSeenAt: { gte: since } },
      }),

      prisma.suggestion.count({ where: { organizationId: orgId } }),

      prisma.suggestionFeedback.count({
        where: { user: { organizationId: orgId }, createdAt: { gte: since } },
      }),

      prisma.suggestionFeedback.count({
        where: {
          user: { organizationId: orgId },
          type: { in: ['APPROVED', 'USED'] },
          createdAt: { gte: since },
        },
      }),

      prisma.suggestionFeedback.count({
        where: {
          user: { organizationId: orgId },
          type: 'REJECTED',
          createdAt: { gte: since },
        },
      }),

      prisma.usageEvent.count({
        where: { organizationId: orgId, createdAt: { gte: since } },
      }),

      prisma.usageEvent.groupBy({
        by: ['eventType'],
        where: { organizationId: orgId, createdAt: { gte: since } },
        _count: { eventType: true },
        orderBy: { _count: { eventType: 'desc' } },
        take: 10,
      }),

      prisma.usageEvent.groupBy({
        by: ['userId'],
        where: { organizationId: orgId, createdAt: { gte: since }, userId: { not: null } },
        _count: { userId: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 5,
      }),

      prisma.template.count({
        where: { organizationId: orgId, isActive: true },
      }),

      prisma.template.count({
        where: { organizationId: orgId, isActive: true, score: { gte: 0.5 } },
      }),

      prisma.usageEvent.findMany({
        where: {
          organizationId: orgId,
          eventType: 'ai.suggestions_generated',
          createdAt: { gte: since },
        },
        select: { payload: true },
        take: 100,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const latencies = avgLatencyRaw
      .map(e => (e.payload as Record<string, unknown>)?.latencyMs)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

    const approvalRate = totalFeedback > 0
      ? parseFloat((approvedFeedback / totalFeedback).toFixed(3))
      : 0;

    res.json({
      period:   { since, until: new Date() },
      users:    { total: totalUsers, active: activeUsers },
      suggestions: {
        total: totalSuggestions,
        approvalRate,
        avgLatencyMs,
      },
      feedback: {
        total:    totalFeedback,
        approved: approvedFeedback,
        rejected: rejectedFeedback,
      },
      events:    {
        total:  totalEvents,
        byType: eventsByType.map(e => ({ type: e.eventType, count: e._count.eventType })),
      },
      templates: { total: totalTemplates, learned: learnedTemplates },
      topUsers:  topUsers.map(u => ({ userId: u.userId, events: u._count.userId })),
    });
  } catch (err) { next(err); }
});

// GET /api/metrics/activity?days=7 — série temporal de eventos
router.get('/activity', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days  = Math.min(parseInt(req.query.days as string) || 7, 90);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const events = await prisma.usageEvent.findMany({
      where: { organizationId: req.organizationId!, createdAt: { gte: since } },
      select: { eventType: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const byDay: Record<string, Record<string, number>> = {};
    events.forEach(e => {
      const day = e.createdAt.toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = {};
      byDay[day][e.eventType] = (byDay[day][e.eventType] || 0) + 1;
    });

    res.json({ days, activity: byDay });
  } catch (err) { next(err); }
});

export default router;
