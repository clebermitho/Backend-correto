jest.mock('../../src/utils/prisma', () => require('../mocks/prisma'));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../../src/utils/cache', () => ({
  cache: {
    get:  jest.fn().mockReturnValue(undefined),
    set:  jest.fn(),
    del:  jest.fn(),
    keys: jest.fn().mockReturnValue([]),
  },
}));

const jwt = require('jsonwebtoken');
const { requireAuth, requireRole } = require('../../src/middleware/auth');
const { prisma } = require('../mocks/prisma');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(overrides = {}) {
  return { headers: {}, ip: '127.0.0.1', path: '/test', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requireAuth', () => {
  it('returns 401 when no Authorization header', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token não fornecido.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token format is invalid (not "Bearer ...")', async () => {
    const req = mockReq({ headers: { authorization: 'Token abc123' } });
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token não fornecido.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when JWT verification fails (JsonWebTokenError)', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer invalidtoken' } });
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when session not found in DB', async () => {
    const token = jwt.sign({ sub: 'user-1', type: 'access' }, process.env.JWT_SECRET);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = jest.fn();

    prisma.session.findUnique.mockResolvedValue(null);

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sessão inválida ou revogada.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when session is revoked', async () => {
    const token = jwt.sign({ sub: 'user-1', type: 'access' }, process.env.JWT_SECRET);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = jest.fn();

    prisma.session.findUnique.mockResolvedValue({
      token,
      isRevoked: true,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      user: { id: 'user-1', isActive: true, role: 'OPERATOR', organizationId: 'org-1', organization: {} },
    });

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sessão inválida ou revogada.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when session is expired', async () => {
    const token = jwt.sign({ sub: 'user-1', type: 'access' }, process.env.JWT_SECRET);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = jest.fn();

    prisma.session.findUnique.mockResolvedValue({
      token,
      isRevoked: false,
      expiresAt: new Date(Date.now() - 1000), // already expired
      user: { id: 'user-1', isActive: true, role: 'OPERATOR', organizationId: 'org-1', organization: {} },
    });
    prisma.session.delete.mockResolvedValue({});

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sessão expirada. Faça login novamente.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user is inactive', async () => {
    const token = jwt.sign({ sub: 'user-1', type: 'access' }, process.env.JWT_SECRET);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = jest.fn();

    prisma.session.findUnique.mockResolvedValue({
      token,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      user: { id: 'user-1', isActive: false, role: 'OPERATOR', organizationId: 'org-1', organization: {} },
    });

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Usuário inativo.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and sets req.user when everything is valid', async () => {
    const token = jwt.sign({ sub: 'user-1', type: 'access' }, process.env.JWT_SECRET);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = jest.fn();

    const user = { id: 'user-1', isActive: true, role: 'ADMIN', organizationId: 'org-1', organization: {} };
    prisma.session.findUnique.mockResolvedValue({
      token,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      user,
    });

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBe(user);
    expect(req.organizationId).toBe('org-1');
    expect(req.sessionToken).toBe(token);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('requireRole', () => {
  it('returns 403 when user role does not match', () => {
    const req = { user: { id: 'user-1', role: 'OPERATOR' }, path: '/admin' };
    const res = mockRes();
    const next = jest.fn();

    requireRole('ADMIN')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Permissão insuficiente.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when role matches', () => {
    const req = { user: { id: 'user-1', role: 'ADMIN' }, path: '/admin' };
    const res = mockRes();
    const next = jest.fn();

    requireRole('ADMIN', 'SUPER_ADMIN')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});
