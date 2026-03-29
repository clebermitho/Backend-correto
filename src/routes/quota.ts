import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

function periodKeyUtc(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

router.get('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.organizationId! },
      select: { id: true, name: true, monthlyQuota: true, usedTokens: true },
    });
    if (!org) { res.status(404).json({ error: 'Organização não encontrada.' }); return; }

    const monthlyQuota = org.monthlyQuota ?? 0;
    const usedTokens   = org.usedTokens   ?? 0;
    const remaining    = Math.max(0, monthlyQuota - usedTokens);

    res.json({
      period: periodKeyUtc(),
      organization: { id: org.id, name: org.name },
      monthlyQuota,
      usedTokens,
      remaining,
    });
  } catch (err) { next(err); }
});

router.put('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = z.object({
      monthlyQuota:    z.number().int().min(0).max(100_000_000).optional(),
      resetUsedTokens: z.boolean().optional(),
    }).parse(req.body);

    if (body.monthlyQuota === undefined && !body.resetUsedTokens) {
      res.status(400).json({ error: 'Nenhuma alteração enviada.' });
      return;
    }

    const data: { monthlyQuota?: number; usedTokens?: number } = {};
    if (body.monthlyQuota !== undefined) data.monthlyQuota = body.monthlyQuota;
    if (body.resetUsedTokens) data.usedTokens = 0;

    const org = await prisma.organization.update({
      where: { id: req.organizationId! },
      data,
      select: { id: true, name: true, monthlyQuota: true, usedTokens: true },
    });

    const monthlyQuota = org.monthlyQuota ?? 0;
    const usedTokens   = org.usedTokens   ?? 0;
    const remaining    = Math.max(0, monthlyQuota - usedTokens);

    res.json({
      period: periodKeyUtc(),
      organization: { id: org.id, name: org.name },
      monthlyQuota,
      usedTokens,
      remaining,
    });
  } catch (err) { next(err); }
});

export default router;
