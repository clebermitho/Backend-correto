const router = require('express').Router();
const { prisma }       = require('../utils/prisma');
const { requireAuth }  = require('../middleware/auth');
const { requireRole }  = require('../middleware/auth');

// GET /api/metrics/summary — visão geral para o admin
router.get('/summary', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const orgId = req.organizationId;
    const since = req.query.since
      ? new Date(req.query.since)
      : new Date(Date.now() - 30 * 24 * 3600 * 1000); // últimos 30 dias

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

      // USED também conta como aprovação (operador clicou e usou)
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

      // Templates total ativos
      prisma.template.count({
        where: { organizationId: orgId, isActive: true },
      }),

      // Templates "aprendidos" = originados de IA com score alto (source AI e score >= 0.5)
      prisma.template.count({
        where: { organizationId: orgId, isActive: true, score: { gte: 0.5 } },
      }),

      // Latência média das sugestões (payload.latencyMs dos eventos)
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

    // Calcular latência média a partir dos eventos
    const latencies = avgLatencyRaw
      .map(e => e.payload?.latencyMs)
      .filter(v => typeof v === 'number' && v > 0);
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
router.get('/activity', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const days  = Math.min(parseInt(req.query.days) || 7, 90);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const events = await prisma.usageEvent.findMany({
      where: { organizationId: req.organizationId, createdAt: { gte: since } },
      select: { eventType: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // Agregar por dia
    const byDay = {};
    events.forEach(e => {
      const day = e.createdAt.toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = {};
      byDay[day][e.eventType] = (byDay[day][e.eventType] || 0) + 1;
    });

    res.json({ days, activity: byDay });
  } catch (err) { next(err); }
});

module.exports = router;
