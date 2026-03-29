import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { log } from '../utils/audit';
import logger from '../utils/logger';

const router = Router();

const USER_SELECT = {
  id: true, name: true, email: true, username: true, role: true,
  isActive: true, lastSeenAt: true, createdAt: true,
  dailyChatLimit: true, dailySuggestionLimit: true,
};

// ── Auxiliar: verificar se usuário tem sessão ativa ──────────
async function isUserOnline(userId: string): Promise<boolean> {
  const now = new Date();
  const active = await prisma.session.findFirst({
    where: { userId, isRevoked: false, expiresAt: { gt: now } },
    select: { id: true },
  });
  return !!active;
}

// ── Auxiliar: obter limite efetivo do usuário ────────────────
async function getEffectiveLimits(
  user: { dailyChatLimit?: number | null; dailySuggestionLimit?: number | null },
  organizationId: string
): Promise<{ effectiveChatLimit: number | null; effectiveSuggestionLimit: number | null }> {
  const settingsRows = await prisma.setting.findMany({
    where: { organizationId, key: { in: ['limits.chatMessagesPerUserPerDay', 'limits.suggestionsPerUserPerDay'] } },
    select: { key: true, value: true },
  });
  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

  const globalChat = settings['limits.chatMessagesPerUserPerDay'] !== undefined
    ? Number(settings['limits.chatMessagesPerUserPerDay'])
    : null;
  const globalSugg = settings['limits.suggestionsPerUserPerDay'] !== undefined
    ? Number(settings['limits.suggestionsPerUserPerDay'])
    : null;

  return {
    effectiveChatLimit:       user.dailyChatLimit       !== null && user.dailyChatLimit       !== undefined ? user.dailyChatLimit       : globalChat,
    effectiveSuggestionLimit: user.dailySuggestionLimit !== null && user.dailySuggestionLimit !== undefined ? user.dailySuggestionLimit : globalSugg,
  };
}

// ── GET /api/users ───────────────────────────────────────────
router.get('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      where:   { organizationId: req.organizationId! },
      select:  USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const userIds = users.map(u => u.id);
    const activeSessions = await prisma.session.findMany({
      where: { userId: { in: userIds }, isRevoked: false, expiresAt: { gt: now } },
      select: { userId: true },
      distinct: ['userId'],
    });
    const onlineSet = new Set(activeSessions.map(s => s.userId));

    const enriched = users.map(u => ({ ...u, isOnline: onlineSet.has(u.id) }));
    res.json({ users: enriched });
  } catch (err) { next(err); }
});

// ── GET /api/users/:id — detalhes e estatísticas do usuário ──
router.get('/:id', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await prisma.user.findFirst({
      where:  { id: req.params.id, organizationId: req.organizationId! },
      select: USER_SELECT,
    });
    if (!user) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [
      todayChatMessages,
      todaySuggestions,
      totalChatMessages,
      totalSuggestions,
      totalFeedbackGiven,
      lastActivityEvent,
      online,
    ] = await Promise.all([
      prisma.usageEvent.count({ where: { userId: user.id, eventType: 'ai.chat_message',         createdAt: { gte: startOfDay } } }),
      prisma.usageEvent.count({ where: { userId: user.id, eventType: 'ai.suggestions_generated', createdAt: { gte: startOfDay } } }),
      prisma.usageEvent.count({ where: { userId: user.id, eventType: 'ai.chat_message' } }),
      prisma.usageEvent.count({ where: { userId: user.id, eventType: 'ai.suggestions_generated' } }),
      prisma.suggestionFeedback.count({ where: { userId: user.id } }),
      prisma.usageEvent.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      isUserOnline(user.id),
    ]);

    const { effectiveChatLimit, effectiveSuggestionLimit } = await getEffectiveLimits(user, req.organizationId!);

    res.json({
      user: {
        ...user,
        isOnline: online,
        stats: {
          todayChatMessages,
          todaySuggestions,
          totalChatMessages,
          totalSuggestions,
          totalFeedbackGiven,
          lastActivity: lastActivityEvent?.createdAt ?? null,
        },
        effectiveChatLimit,
        effectiveSuggestionLimit,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/users — criar agente ───────────────────────────
router.post('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = z.object({
      name:     z.string().min(2, 'Nome muito curto.'),
      email:    z.string().email('E-mail inválido.').optional(),
      username: z.string().min(1, 'Username muito curto.').optional(),
      password: z.string().min(6, 'Mínimo 6 caracteres.'),
      role:     z.enum(['AGENT', 'ADMIN']).default('AGENT'),
    }).refine(d => d.email || d.username, { message: 'Informe e-mail ou username.' })
      .parse(req.body);

    if (data.email) {
      const emailExists = await prisma.user.findUnique({ where: { email: data.email.toLowerCase().trim() } });
      if (emailExists) { res.status(409).json({ error: 'E-mail já registrado.' }); return; }
    }
    if (data.username) {
      const usernameExists = await prisma.user.findUnique({ where: { username: data.username.trim() } });
      if (usernameExists) { res.status(409).json({ error: 'Username já registrado.' }); return; }
    }

    const hash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        organizationId: req.organizationId!,
        email:          data.email ? data.email.toLowerCase().trim() : null,
        username:       data.username ? data.username.trim() : null,
        passwordHash:   hash,
        name:           data.name,
        role:           data.role,
      },
      select: USER_SELECT,
    });

    log({ organizationId: req.organizationId!, userId: req.user!.id,
          eventType: 'user.created', payload: { newUserId: user.id, email: user.email, role: user.role } });
    logger.info({ event: 'user.created', by: req.user!.id, newUser: user.id });

    res.status(201).json({ user });
  } catch (err) { next(err); }
});

// ── PATCH /api/users/:id — ativar/desativar / trocar role ────
router.patch('/:id', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const updates = z.object({
      isActive:             z.boolean().optional(),
      role:                 z.enum(['AGENT', 'ADMIN']).optional(),
      name:                 z.string().min(2).optional(),
      dailyChatLimit:       z.number().int().min(0).nullable().optional(),
      dailySuggestionLimit: z.number().int().min(0).nullable().optional(),
    }).parse(req.body);

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'Nenhum campo para atualizar.' });
      return;
    }

    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
    });
    if (!existing) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }

    if (req.params.id === req.user!.id && updates.isActive === false) {
      res.status(400).json({ error: 'Não é possível desativar sua própria conta.' });
      return;
    }

    const user = await prisma.user.update({
      where:  { id: req.params.id },
      data:   updates,
      select: USER_SELECT,
    });

    log({ organizationId: req.organizationId!, userId: req.user!.id,
          eventType: 'user.updated', payload: { targetId: user.id, updates } });

    res.json({ user });
  } catch (err) { next(err); }
});

// ── POST /api/users/:id/reset-password — admin reseta senha ──
router.post('/:id/reset-password', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { newPassword } = z.object({
      newPassword: z.string().min(6, 'Mínimo 6 caracteres.'),
    }).parse(req.body);

    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
    });
    if (!existing) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: hash } });

    await prisma.session.deleteMany({ where: { userId: req.params.id } });

    log({ organizationId: req.organizationId!, userId: req.user!.id,
          eventType: 'user.password_reset', payload: { targetId: req.params.id } });

    res.json({ ok: true, message: 'Senha alterada. Sessões anteriores revogadas.' });
  } catch (err) { next(err); }
});

export default router;
