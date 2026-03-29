import jwt from 'jsonwebtoken';
import { prisma } from './prisma';

const ACCESS_TTL_HOURS  = parseInt(process.env.JWT_TTL_HOURS    || '8');
const REFRESH_TTL_DAYS  = parseInt(process.env.JWT_REFRESH_DAYS || '30');

// ── Access Token (sessão curta) ──────────────────────────────
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + ACCESS_TTL_HOURS * 3600 * 1000);

  const token = jwt.sign(
    { sub: userId, type: 'access' },
    process.env.JWT_SECRET!,
    { expiresIn: `${ACCESS_TTL_HOURS}h` }
  );

  await prisma.session.create({
    data: {
      userId,
      token,
      type: 'ACCESS',
      expiresAt,
    },
  });
  return { token, expiresAt };
}

// ── Refresh Token (sessão longa) ─────────────────────────────
export async function createRefreshToken(userId: string): Promise<{ refreshToken: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);

  const refreshToken = jwt.sign(
    { sub: userId, type: 'refresh' },
    process.env.JWT_SECRET!,
    { expiresIn: `${REFRESH_TTL_DAYS}d` }
  );

  await prisma.session.create({
    data: {
      userId,
      token:     refreshToken,
      type:      'REFRESH',
      expiresAt,
    },
  });

  return { refreshToken, expiresAt };
}

// ── Revogar sessão ───────────────────────────────────────────
export async function revokeSession(token: string): Promise<void> {
  await prisma.session.updateMany({
    where: { token },
    data: { isRevoked: true },
  });
}

// ── Limpeza de sessões expiradas ─────────────────────────────
export async function cleanExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { isRevoked: true, type: 'ACCESS' },
      ],
    },
  });
  return count;
}

// ── Renovar access token a partir do refresh token ───────────
export async function refreshAccessToken(refreshToken: string): Promise<{
  token: string;
  expiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}> {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(refreshToken, process.env.JWT_SECRET!) as jwt.JwtPayload;
  } catch {
    throw new Error('Refresh token inválido.');
  }

  if (payload.type !== 'refresh') {
    throw new Error('Token não é um refresh token.');
  }

  const session = await prisma.session.findUnique({ where: { token: refreshToken } });
  if (!session || session.isRevoked || new Date() > session.expiresAt) {
    throw new Error('Refresh token expirado ou revogado.');
  }

  // Verificar se o usuário ainda está ativo
  const user = await prisma.user.findUnique({ where: { id: payload.sub as string } });
  if (!user || !user.isActive) {
    throw new Error('Usuário inativo ou não encontrado.');
  }

  // Revogar o refresh token antigo (Refresh Token Rotation para segurança extra)
  await revokeSession(refreshToken);

  // Emitir novo access token E novo refresh token
  const [access, refresh] = await Promise.all([
    createSession(user.id),
    createRefreshToken(user.id),
  ]);

  return {
    token:            access.token,
    expiresAt:        access.expiresAt,
    refreshToken:     refresh.refreshToken,
    refreshExpiresAt: refresh.expiresAt,
  };
}
