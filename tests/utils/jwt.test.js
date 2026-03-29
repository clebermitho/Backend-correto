jest.mock('../../src/utils/prisma', () => require('../mocks/prisma'));

const jwt = require('jsonwebtoken');
const {
  createSession,
  createRefreshToken,
  revokeSession,
  cleanExpiredSessions,
  refreshAccessToken,
} = require('../../src/utils/jwt');
const { prisma } = require('../mocks/prisma');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createSession', () => {
  it('creates a JWT access token and stores it in DB', async () => {
    prisma.session.create.mockResolvedValue({});

    const result = await createSession('user-1');

    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('expiresAt');
    expect(typeof result.token).toBe('string');

    const payload = jwt.verify(result.token, process.env.JWT_SECRET);
    expect(payload.sub).toBe('user-1');
    expect(payload.type).toBe('access');

    expect(prisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          token: result.token,
          type: 'ACCESS',
        }),
      })
    );
  });
});

describe('createRefreshToken', () => {
  it('creates a JWT refresh token and stores it in DB', async () => {
    prisma.session.create.mockResolvedValue({});

    const result = await createRefreshToken('user-1');

    expect(result).toHaveProperty('refreshToken');
    expect(result).toHaveProperty('expiresAt');
    expect(typeof result.refreshToken).toBe('string');

    const payload = jwt.verify(result.refreshToken, process.env.JWT_SECRET);
    expect(payload.sub).toBe('user-1');
    expect(payload.type).toBe('refresh');

    expect(prisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          token: result.refreshToken,
          type: 'REFRESH',
        }),
      })
    );
  });
});

describe('revokeSession', () => {
  it('marks session as revoked in DB', async () => {
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await revokeSession('some-token');

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { token: 'some-token' },
      data: { isRevoked: true },
    });
  });
});

describe('cleanExpiredSessions', () => {
  it('deletes expired sessions and returns count', async () => {
    prisma.session.deleteMany.mockResolvedValue({ count: 5 });

    const count = await cleanExpiredSessions();

    expect(count).toBe(5);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.any(Array),
        }),
      })
    );
  });
});

describe('refreshAccessToken', () => {
  it('throws when refresh token is invalid', async () => {
    await expect(refreshAccessToken('invalid.token.here')).rejects.toThrow('Refresh token inválido.');
  });

  it('throws when token type is not "refresh"', async () => {
    const accessToken = jwt.sign(
      { sub: 'user-1', type: 'access' },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    await expect(refreshAccessToken(accessToken)).rejects.toThrow('Token não é um refresh token.');
  });

  it('throws when refresh token session is not found or revoked', async () => {
    const refreshToken = jwt.sign(
      { sub: 'user-1', type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    prisma.session.findUnique.mockResolvedValue(null);

    await expect(refreshAccessToken(refreshToken)).rejects.toThrow('Refresh token expirado ou revogado.');
  });

  it('throws when user is inactive', async () => {
    const refreshToken = jwt.sign(
      { sub: 'user-1', type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    prisma.session.findUnique.mockResolvedValue({
      token: refreshToken,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 86400 * 1000),
    });

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', isActive: false });

    await expect(refreshAccessToken(refreshToken)).rejects.toThrow('Usuário inativo ou não encontrado.');
  });

  it('returns new tokens when refresh token is valid', async () => {
    const refreshToken = jwt.sign(
      { sub: 'user-1', type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    prisma.session.findUnique.mockResolvedValue({
      token: refreshToken,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 86400 * 1000),
    });

    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', isActive: true });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    prisma.session.create.mockResolvedValue({});

    const result = await refreshAccessToken(refreshToken);

    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('expiresAt');
    expect(result).toHaveProperty('refreshToken');
    expect(result).toHaveProperty('refreshExpiresAt');
  });
});
