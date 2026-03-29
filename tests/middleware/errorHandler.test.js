jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { ZodError, z } = require('zod');
const { errorHandler, createError } = require('../../src/middleware/errorHandler');

function mockReq(overrides = {}) {
  return { path: '/test', method: 'GET', user: null, ...overrides };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('errorHandler', () => {
  it('handles ZodError → 400 with issues', () => {
    const schema = z.object({ name: z.string() });
    let zodErr;
    try {
      schema.parse({ name: 123 });
    } catch (e) {
      zodErr = e;
    }

    const req = mockReq();
    const res = mockRes();

    errorHandler(zodErr, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('Dados inválidos.');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('handles error with statusCode → returns that status', () => {
    const err = createError('Not found', 404);
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('handles Prisma P2002 → 409', () => {
    const err = new Error('Unique constraint failed');
    err.code = 'P2002';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Registro duplicado.' });
  });

  it('handles Prisma P2025 → 404', () => {
    const err = new Error('Record not found');
    err.code = 'P2025';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Registro não encontrado.' });
  });

  it('handles Prisma P2003 → 400', () => {
    const err = new Error('Foreign key constraint failed');
    err.code = 'P2003';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Referência inválida: registro relacionado não encontrado.' });
  });

  it('handles PrismaClientValidationError → 400', () => {
    const err = new Error('Argument missing');
    err.name = 'PrismaClientValidationError';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Dados inválidos para a operação no banco de dados.' });
  });

  it('handles PrismaClientInitializationError → 503', () => {
    const err = new Error('Cannot connect to database');
    err.name = 'PrismaClientInitializationError';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'Banco de dados temporariamente indisponível. Tente novamente em instantes.' });
  });

  it('handles AbortError → 504', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith({ error: 'Operação cancelada por timeout.' });
  });

  it('handles unknown error → 500', () => {
    const err = new Error('Something unexpected happened');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Erro interno do servidor.' });
  });
});

describe('createError', () => {
  it('creates error with message and statusCode', () => {
    const err = createError('Custom error', 422);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Custom error');
    expect(err.statusCode).toBe(422);
  });

  it('defaults statusCode to 400 when not provided', () => {
    const err = createError('Bad input');

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Bad input');
  });
});
