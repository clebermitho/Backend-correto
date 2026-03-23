const router = require('express').Router();
const { z }  = require('zod');
const { prisma }      = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

// GET /api/settings — todas as configurações da org (extensão usa isso no boot)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await prisma.setting.findMany({
      where: { organizationId: req.organizationId },
      select: { key: true, value: true },
    });

    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({ settings });
  } catch (err) { next(err); }
});

// PUT /api/settings/bulk — salvar múltiplas configurações de uma vez (admin)
// Chamado pelo painel admin quando o usuário clica em "Salvar" — mais eficiente que N requests
router.put('/bulk', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { settings } = z.object({
      settings: z.record(z.union([z.string(), z.number(), z.boolean()])),
    }).parse(req.body);

    const entries = Object.entries(settings);
    if (entries.length === 0) {
      return res.status(400).json({ error: 'Nenhuma configuração enviada.' });
    }
    if (entries.length > 50) {
      return res.status(400).json({ error: 'Máximo de 50 configurações por vez.' });
    }

    // Upsert em transação — garante atomicidade
    await prisma.$transaction(
      entries.map(([key, value]) =>
        prisma.setting.upsert({
          where:  { organizationId_key: { organizationId: req.organizationId, key } },
          create: { organizationId: req.organizationId, key, value },
          update: { value },
        })
      )
    );

    // Retornar estado atual após salvar
    const rows = await prisma.setting.findMany({
      where:  { organizationId: req.organizationId },
      select: { key: true, value: true },
    });
    const saved = Object.fromEntries(rows.map(r => [r.key, r.value]));

    res.json({ saved: entries.length, settings: saved });
  } catch (err) { next(err); }
});

// PUT /api/settings/:key — atualizar configuração individual (apenas ADMIN)
router.put('/:key', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { key }   = req.params;
    const { value } = z.object({ value: z.unknown() }).parse(req.body);

    const setting = await prisma.setting.upsert({
      where:  { organizationId_key: { organizationId: req.organizationId, key } },
      create: { organizationId: req.organizationId, key, value },
      update: { value },
    });

    res.json(setting);
  } catch (err) { next(err); }
});

// DELETE /api/settings/:key
router.delete('/:key', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    await prisma.setting.delete({
      where: { organizationId_key: { organizationId: req.organizationId, key: req.params.key } },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
