import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// GET /api/templates?category=NEGOCIACAO
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const templates = await prisma.template.findMany({
      where: {
        organizationId: req.organizationId!,
        isActive: true,
        ...(req.query.category ? { category: req.query.category as string } : {}),
      },
      orderBy: [{ score: 'desc' }, { usageCount: 'desc' }],
      take: 20,
    });
    res.json({ templates });
  } catch (err) { next(err); }
});

// POST /api/templates — admin cria template manual
router.post('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = z.object({
      category: z.string(),
      text:     z.string().min(5),
    }).parse(req.body);

    const t = await prisma.template.create({
      data: { ...data, organizationId: req.organizationId! },
    });
    res.status(201).json(t);
  } catch (err) { next(err); }
});

// DELETE /api/templates/:id
router.delete('/:id', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await prisma.template.update({
      where: { id: req.params.id },
      data:  { isActive: false },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
