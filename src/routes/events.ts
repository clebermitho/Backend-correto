import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

const eventSchema = z.object({
  eventType: z.string().min(3).max(100),
  payload:   z.record(z.unknown()).optional().default({}),
});

// ── POST /api/events — extensão registra eventos ─────────────
router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { eventType, payload } = eventSchema.parse(req.body);

    if (!req.organizationId) {
      res.status(400).json({ error: 'Usuário sem organização associada.' });
      return;
    }

    const event = await prisma.usageEvent.create({
      data: {
        organizationId: req.organizationId,
        userId:         req.user!.id,
        eventType,
        payload:        payload as Prisma.InputJsonValue,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    });

    res.status(201).json({ id: event.id });
  } catch (err) { next(err); }
});

// ── GET /api/events — listar eventos com filtros ─────────────
router.get('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit      = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const eventType  = req.query.eventType as string | undefined;
    const userId     = req.query.userId as string | undefined;
    const since      = req.query.since ? new Date(req.query.since as string) : undefined;

    const events = await prisma.usageEvent.findMany({
      where: {
        organizationId: req.organizationId!,
        ...(eventType ? { eventType }      : {}),
        ...(userId    ? { userId }         : {}),
        ...(since     ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      select:  {
        id: true, eventType: true, payload: true, createdAt: true, ipAddress: true,
        user: { select: { id: true, name: true } },
      },
    });

    res.json({ events, total: events.length });
  } catch (err) { next(err); }
});

// ── GET /api/events/recent — visão rápida para dashboard admin
router.get('/recent', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit  = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const filter = req.query.filter as string | undefined;

    const typeFilter = (() => {
      if (filter === 'errors') return { startsWith: 'error.' };
      if (filter === 'ai')     return { startsWith: 'ai.' };
      if (filter === 'auth')   return { startsWith: 'auth.' };
      return undefined;
    })();

    const events = await prisma.usageEvent.findMany({
      where: {
        organizationId: req.organizationId!,
        ...(typeFilter ? { eventType: typeFilter } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      select:  {
        id: true, eventType: true, payload: true, createdAt: true,
        user: { select: { id: true, name: true } },
      },
    });

    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const summary  = await prisma.usageEvent.groupBy({
      by:      ['eventType'],
      where:   { organizationId: req.organizationId!, createdAt: { gte: since24h } },
      _count:  { eventType: true },
      orderBy: { _count: { eventType: 'desc' } },
      take:    15,
    });

    res.json({
      events,
      summary24h: summary.map(s => ({ type: s.eventType, count: s._count.eventType })),
    });
  } catch (err) { next(err); }
});

export default router;
