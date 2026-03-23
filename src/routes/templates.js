const router = require('express').Router();
const { z }  = require('zod');
const { prisma }      = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

// GET /api/templates?category=NEGOCIACAO
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const templates = await prisma.template.findMany({
      where: {
        organizationId: req.organizationId,
        isActive: true,
        ...(req.query.category ? { category: req.query.category } : {}),
      },
      orderBy: [{ score: 'desc' }, { usageCount: 'desc' }],
      take: 20,
    });
    res.json({ templates });
  } catch (err) { next(err); }
});

// POST /api/templates — admin cria template manual
router.post('/', requireAuth, requireRole('ADMIN','SUPER_ADMIN'), async (req, res, next) => {
  try {
    const data = z.object({
      category: z.string(),
      text:     z.string().min(5),
    }).parse(req.body);

    const t = await prisma.template.create({
      data: { ...data, organizationId: req.organizationId },
    });
    res.status(201).json(t);
  } catch (err) { next(err); }
});

// DELETE /api/templates/:id
router.delete('/:id', requireAuth, requireRole('ADMIN','SUPER_ADMIN'), async (req, res, next) => {
  try {
    await prisma.template.update({
      where: { id: req.params.id },
      data:  { isActive: false },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
