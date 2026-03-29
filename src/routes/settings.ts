import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// GET /api/settings — todas as configurações da org
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rows = await prisma.setting.findMany({
      where: { organizationId: req.organizationId! },
      select: { key: true, value: true },
    });

    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({ settings });
  } catch (err) { next(err); }
});

// PUT /api/settings/bulk — salvar múltiplas configurações de uma vez
router.put('/bulk', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { settings } = z.object({
      settings: z.record(z.union([z.string(), z.number(), z.boolean()])),
    }).parse(req.body);

    const entries = Object.entries(settings);
    if (entries.length === 0) {
      res.status(400).json({ error: 'Nenhuma configuração enviada.' });
      return;
    }
    if (entries.length > 50) {
      res.status(400).json({ error: 'Máximo de 50 configurações por vez.' });
      return;
    }

    await prisma.$transaction(
      entries.map(([key, value]) =>
        prisma.setting.upsert({
          where:  { organizationId_key: { organizationId: req.organizationId!, key } },
          create: { organizationId: req.organizationId!, key, value },
          update: { value },
        })
      )
    );

    const rows = await prisma.setting.findMany({
      where:  { organizationId: req.organizationId! },
      select: { key: true, value: true },
    });
    const saved = Object.fromEntries(rows.map(r => [r.key, r.value]));

    res.json({ saved: entries.length, settings: saved });
  } catch (err) { next(err); }
});

// PUT /api/settings/:key — atualizar configuração individual
router.put('/:key', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { key }   = req.params;
    const { value } = z.object({ value: z.unknown() }).parse(req.body);

    const setting = await prisma.setting.upsert({
      where:  { organizationId_key: { organizationId: req.organizationId!, key } },
      create: { organizationId: req.organizationId!, key, value: value as Prisma.InputJsonValue },
      update: { value: value as Prisma.InputJsonValue },
    });

    res.json(setting);
  } catch (err) { next(err); }
});

// DELETE /api/settings/:key
router.delete('/:key', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await prisma.setting.delete({
      where: { organizationId_key: { organizationId: req.organizationId!, key: req.params.key } },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
