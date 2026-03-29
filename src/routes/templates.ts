import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { cache } from '../utils/cache';

const router = Router();

// GET /api/templates?category=NEGOCIACAO
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orgId    = req.organizationId!;
    const category = req.query.category as string | undefined;
    const cacheKey = `templates:${orgId}:${category ?? ''}`;
    const cached   = cache.get<unknown[]>(cacheKey);
    if (cached) { res.json({ templates: cached }); return; }

    const templates = await prisma.template.findMany({
      where: {
        organizationId: orgId,
        isActive: true,
        ...(category ? { category } : {}),
      },
      orderBy: [{ score: 'desc' }, { usageCount: 'desc' }],
      take: 20,
    });
    cache.set(cacheKey, templates);
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
    // Invalidate both the "no-filter" and the category-specific caches
    cache.del(`templates:${req.organizationId!}:`);
    cache.del(`templates:${req.organizationId!}:${data.category}`);
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
    // Invalidate all template cache keys for this org
    const orgId = req.organizationId!;
    cache.keys().filter(k => k.startsWith(`templates:${orgId}:`)).forEach(k => cache.del(k));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
