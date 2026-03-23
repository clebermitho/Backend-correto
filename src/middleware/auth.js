const jwt    = require('jsonwebtoken');
const { prisma } = require('../utils/prisma');
const logger = require('../utils/logger');

/**
 * requireAuth — verifica Bearer token JWT.
 * Injeta req.user e req.organizationId para as rotas seguintes.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }

  const token = header.slice(7);

  try {
    // Verificar assinatura JWT
    jwt.verify(token, process.env.JWT_SECRET);

    // Verificar sessão no banco (permite revogação manual)
    const session = await prisma.session.findUnique({
      where:   { token },
      include: { user: { include: { organization: true } } },
    });

    if (!session || session.isRevoked) {
      logger.warn({ event: 'auth.invalid_session', ip: req.ip, path: req.path, revoked: session?.isRevoked });
      return res.status(401).json({ error: 'Sessão inválida ou revogada.' });
    }

    if (new Date() > session.expiresAt) {
      // Limpar sessão expirada (lazy cleanup)
      prisma.session.delete({ where: { token } }).catch(() => {});
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }

    if (!session.user.isActive) {
      return res.status(403).json({ error: 'Usuário inativo.' });
    }

    req.user              = session.user;
    req.organizationId    = session.user.organizationId;
    req.sessionToken      = token;
    req.sessionExpiresAt  = session.expiresAt;  // exposto para GET /auth/me
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token inválido.' });
    }
    // Qualquer erro Prisma / de rede → banco offline ou config incorreta → 503
    const isPrismaError = err.name?.includes('Prisma') ||
      typeof err.code === 'string' && err.code.startsWith('P') ||
      err.message?.includes('connect') ||
      err.message?.includes('ECONNREFUSED') ||
      err.message?.includes('timed out') ||
      err.message?.includes('closed') ||      // P1017: Server has closed the connection
      err.message?.includes('pool') ||        // pool timeout / pool exhausted
      err.message?.includes('database');       // qualquer mensagem sobre o banco
    if (isPrismaError) {
      logger.warn({ event: 'auth.db_unavailable', path: req.path, errCode: err.code, err: err.message?.slice(0, 200) });
      return res.status(503).json({ error: 'Banco de dados temporariamente indisponível. Tente novamente em instantes.' });
    }
    next(err);
  }
}

/**
 * requireRole — garante que o usuário tem o papel mínimo exigido.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      logger.warn({
        event:  'auth.insufficient_role',
        userId: req.user?.id,
        role:   req.user?.role,
        required: roles,
        path:   req.path,
      });
      return res.status(403).json({ error: 'Permissão insuficiente.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
