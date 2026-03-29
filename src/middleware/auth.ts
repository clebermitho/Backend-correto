import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

/**
 * requireAuth — verifica Bearer token JWT.
 * Injeta req.user e req.organizationId para as rotas seguintes.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token não fornecido.' });
    return;
  }

  const token = header.slice(7);

  try {
    // Verificar assinatura JWT
    jwt.verify(token, process.env.JWT_SECRET!);

    // Verificar sessão no banco (permite revogação manual)
    const session = await prisma.session.findUnique({
      where:   { token },
      include: { user: { include: { organization: true } } },
    });

    if (!session || session.isRevoked) {
      logger.warn({ event: 'auth.invalid_session', ip: req.ip, path: req.path, revoked: session?.isRevoked });
      res.status(401).json({ error: 'Sessão inválida ou revogada.' });
      return;
    }

    if (new Date() > session.expiresAt) {
      // Limpar sessão expirada (lazy cleanup)
      prisma.session.delete({ where: { token } }).catch(() => {});
      res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
      return;
    }

    if (!session.user.isActive) {
      res.status(403).json({ error: 'Usuário inativo.' });
      return;
    }

    req.user             = session.user;
    req.organizationId   = session.user.organizationId;
    req.sessionToken     = token;
    req.sessionExpiresAt = session.expiresAt;
    next();
  } catch (err) {
    const e = err as Record<string, unknown>;
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Token inválido.' });
      return;
    }
    // Qualquer erro Prisma / de rede → banco offline ou config incorreta → 503
    const isPrismaError =
      typeof e.name === 'string' && e.name.includes('Prisma') ||
      typeof e.code === 'string' && (e.code as string).startsWith('P') ||
      typeof e.message === 'string' && (
        (e.message as string).includes('connect') ||
        (e.message as string).includes('ECONNREFUSED') ||
        (e.message as string).includes('timed out') ||
        (e.message as string).includes('closed') ||
        (e.message as string).includes('pool') ||
        (e.message as string).includes('database')
      );
    if (isPrismaError) {
      logger.warn({ event: 'auth.db_unavailable', path: req.path, errCode: e.code, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
      res.status(503).json({ error: 'Banco de dados temporariamente indisponível. Tente novamente em instantes.' });
      return;
    }
    next(err);
  }
}

/**
 * requireRole — garante que o usuário tem o papel mínimo exigido.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      logger.warn({
        event:    'auth.insufficient_role',
        userId:   req.user?.id,
        role:     req.user?.role,
        required: roles,
        path:     req.path,
      });
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    next();
  };
}
