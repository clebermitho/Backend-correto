const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { z }   = require('zod');
const { prisma }      = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { log }         = require('../utils/audit');
const logger          = require('../utils/logger');

const USER_SELECT = {
  id: true, name: true, email: true, role: true,
  isActive: true, lastSeenAt: true, createdAt: true,
};

// ── GET /api/users ───────────────────────────────────────────
router.get('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where:   { organizationId: req.organizationId },
      select:  USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ users });
  } catch (err) { next(err); }
});

// ── POST /api/users — criar agente ───────────────────────────
router.post('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const data = z.object({
      name:     z.string().min(2, 'Nome muito curto.'),
      email:    z.string().email('E-mail inválido.'),
      password: z.string().min(8, 'Mínimo 8 caracteres.'),
      role:     z.enum(['AGENT', 'ADMIN']).default('AGENT'),
    }).parse(req.body);

    const exists = await prisma.user.findUnique({ where: { email: data.email.toLowerCase().trim() } });
    if (exists) return res.status(409).json({ error: 'E-mail já registrado.' });

    const hash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        organizationId: req.organizationId,
        email:          data.email.toLowerCase().trim(),
        passwordHash:   hash,
        name:           data.name,
        role:           data.role,
      },
      select: USER_SELECT,
    });

    log({ organizationId: req.organizationId, userId: req.user.id,
          eventType: 'user.created', payload: { newUserId: user.id, email: user.email, role: user.role } });
    logger.info({ event: 'user.created', by: req.user.id, newUser: user.id });

    res.status(201).json({ user });
  } catch (err) { next(err); }
});

// ── PATCH /api/users/:id — ativar/desativar / trocar role ────
router.patch('/:id', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const updates = z.object({
      isActive: z.boolean().optional(),
      role:     z.enum(['AGENT', 'ADMIN']).optional(),
      name:     z.string().min(2).optional(),
    }).parse(req.body);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    }

    // Garante que o usuário pertence à org
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
    });
    if (!existing) return res.status(404).json({ error: 'Usuário não encontrado.' });

    // Admin não pode revogar a si mesmo
    if (req.params.id === req.user.id && updates.isActive === false) {
      return res.status(400).json({ error: 'Não é possível desativar sua própria conta.' });
    }

    const user = await prisma.user.update({
      where:  { id: req.params.id },
      data:   updates,
      select: USER_SELECT,
    });

    log({ organizationId: req.organizationId, userId: req.user.id,
          eventType: 'user.updated', payload: { targetId: user.id, updates } });

    res.json({ user });
  } catch (err) { next(err); }
});

// ── POST /api/users/:id/reset-password — admin reseta senha ──
router.post('/:id/reset-password', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { newPassword } = z.object({
      newPassword: z.string().min(8, 'Mínimo 8 caracteres.'),
    }).parse(req.body);

    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
    });
    if (!existing) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: hash } });

    // Revogar todas as sessões do usuário para forçar novo login
    await prisma.session.deleteMany({ where: { userId: req.params.id } });

    log({ organizationId: req.organizationId, userId: req.user.id,
          eventType: 'user.password_reset', payload: { targetId: req.params.id } });

    res.json({ ok: true, message: 'Senha alterada. Sessões anteriores revogadas.' });
  } catch (err) { next(err); }
});

module.exports = router;
