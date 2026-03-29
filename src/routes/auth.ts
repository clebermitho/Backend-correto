import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { createSession, createRefreshToken, revokeSession, refreshAccessToken } from '../utils/jwt';
import { requireAuth } from '../middleware/auth';
import { log } from '../utils/audit';
import logger from '../utils/logger';

const router = Router();

const loginSchema = z.object({
  email:    z.string().email('E-mail inválido.'),
  password: z.string().min(1, 'Senha obrigatória.'),
});

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     summary: Realiza login do usuário
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, example: "admin@chatplay.com" }
 *               password: { type: string, example: "senha123" }
 *     responses:
 *       200:
 *         description: Login realizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string }
 *                 refreshToken: { type: string }
 *                 user: { type: object }
 *       401:
 *         description: Credenciais inválidas
 */
router.post('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where:   { email: email.toLowerCase().trim() },
      include: { organization: true },
    });

    // Resposta genérica intencional (sem revelar se o e-mail existe)
    if (!user || !user.isActive) {
      logger.warn({ event: 'auth.login_failed', email, reason: user ? 'inactive' : 'not_found', ip: req.ip });
      res.status(401).json({ error: 'Credenciais inválidas.' });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      logger.warn({ event: 'auth.login_failed', email, reason: 'wrong_password', ip: req.ip });
      res.status(401).json({ error: 'Credenciais inválidas.' });
      return;
    }

    const [
      { token, expiresAt },
      { refreshToken, expiresAt: refreshExpiresAt },
    ] = await Promise.all([
      createSession(user.id),
      createRefreshToken(user.id),
    ]);

    // Atualizar lastSeenAt de forma não-bloqueante
    prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } }).catch(() => {});

    log({ organizationId: user.organizationId, userId: user.id, eventType: 'auth.login', req });
    logger.info({ event: 'auth.login_ok', userId: user.id, email, ip: req.ip });

    res.json({
      token,
      expiresAt,
      refreshToken,
      refreshExpiresAt,
      user: {
        id:           user.id,
        name:         user.name,
        email:        user.email,
        role:         user.role,
        organization: user.organization ? {
          id:   user.organization.id,
          name: user.organization.name,
          slug: user.organization.slug,
        } : null,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh — renovar access token ────────────
router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { refreshToken } = z.object({
      refreshToken: z.string().min(1, 'refreshToken obrigatório.'),
    }).parse(req.body);

    const { token, expiresAt } = await refreshAccessToken(refreshToken);
    logger.info({ event: 'auth.token_refreshed' });
    res.json({ token, expiresAt });
  } catch (err) {
    const e = err as Error;
    if (
      e.message?.includes('inválido') ||
      e.message?.includes('expirado') ||
      e.message?.includes('revogado') ||
      e.message?.includes('Refresh token')
    ) {
      res.status(401).json({ error: e.message });
      return;
    }
    next(err);
  }
});

// ── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await revokeSession(req.sessionToken!);
    log({ organizationId: req.organizationId!, userId: req.user!.id, eventType: 'auth.logout', req });
    logger.info({ event: 'auth.logout', userId: req.user!.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const u = req.user!;

    // Lazy lastSeenAt update — evita muitas escritas (atualiza apenas a cada 5 min)
    const threshold = 5 * 60 * 1000;
    const now       = Date.now();
    const lastSeen  = u.lastSeenAt ? new Date(u.lastSeenAt).getTime() : 0;
    if (now - lastSeen > threshold) {
      prisma.user.update({ where: { id: u.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }

    const expiresAt = req.sessionExpiresAt ? req.sessionExpiresAt.toISOString() : null;

    res.json({
      user: {
        id:             u.id,
        name:           u.name,
        email:          u.email,
        role:           u.role,
        organizationId: u.organizationId,
        organization:   u.organization
          ? { id: u.organization.id, name: u.organization.name, slug: u.organization.slug }
          : undefined,
      },
      expiresAt,
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/register (bootstrap — primeiro admin) ─────
router.post('/register', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userCount = await prisma.user.count();
    const isFirstRun = userCount === 0;

    const schema = z.object({
      name:        z.string().min(2),
      email:       z.string().email(),
      password:    z.string().min(8, 'Mínimo 8 caracteres.'),
      orgName:     z.string().min(2),
      orgSlug:     z.string().min(2).regex(/^[a-z0-9-]+$/, 'Apenas letras minúsculas, números e hífens.'),
      adminSecret: z.string().optional(),
    });

    const data = schema.parse(req.body);

    // Segurança: se já houver usuários, exige o segredo. Se for o primeiro, permite (setup inicial).
    if (!isFirstRun && data.adminSecret !== process.env.ADMIN_BOOTSTRAP_SECRET) {
      logger.warn({
        event: 'auth.register_forbidden',
        email: data.email,
        reason: 'admin_secret_required_or_mismatch',
        userCount,
        ip: req.ip,
      });
      res.status(403).json({
        error: 'Registro bloqueado.',
        details: isFirstRun ? 'Erro interno de configuração.' : 'O banco já possui usuários. Informe o adminSecret para criar novos administradores.',
      });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      res.status(409).json({ error: 'E-mail já registrado.' });
      return;
    }

    const org = await prisma.organization.upsert({
      where:  { slug: data.orgSlug },
      create: {
        name: data.orgName,
        slug: data.orgSlug,
        monthlyQuota: 50000,
      },
      update: {},
    });

    const hash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: data.email,
        passwordHash: hash,
        name: data.name,
        role: 'ADMIN',
      },
    });

    const { token, expiresAt } = await createSession(user.id);
    const { refreshToken } = await createRefreshToken(user.id);

    logger.info({ event: 'auth.register_ok', userId: user.id, orgId: org.id, isFirstRun });
    res.status(201).json({
      token,
      expiresAt,
      refreshToken,
      userId: user.id,
      orgId:  org.id,
    });
  } catch (err) { next(err); }
});

export default router;
