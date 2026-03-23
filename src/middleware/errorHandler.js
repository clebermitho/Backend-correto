const { ZodError } = require('zod');
const logger       = require('../utils/logger');

/**
 * Middleware global de tratamento de erros.
 * Deve ser registrado ÚLTIMO no app.use().
 */
function errorHandler(err, req, res, _next) {
  // Erros de validação Zod — 400 Bad Request
  if (err instanceof ZodError) {
    // Logar para facilitar diagnóstico
    logger.warn({
      event:  'validation.failed',
      path:   req.path,
      issues: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
    return res.status(400).json({
      error:  'Dados inválidos.',
      issues: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
  }

  // Erros conhecidos com statusCode
  if (err.statusCode) {
    if (err.statusCode >= 500) {
      logger.error({ event: 'http.error', status: err.statusCode, msg: err.message,
                     path: req.path, method: req.method, userId: req.user?.id });
    }
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Erros do Prisma
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'Registro duplicado.' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Registro não encontrado.' });
  }
  if (err.code === 'P2003') {
    return res.status(400).json({ error: 'Referência inválida: registro relacionado não encontrado.' });
  }
  if (err.code === 'P2000') {
    return res.status(400).json({ error: 'Valor muito longo para o campo.' });
  }
  if (err.code === 'P1008' || err.code === 'P2024') {
    return res.status(503).json({ error: 'Banco de dados sobrecarregado. Tente novamente.' });
  }
  if (err.code === 'P1001' || err.code === 'P1002') {
    return res.status(503).json({ error: 'Banco de dados indisponível. Tente novamente.' });
  }
  // Erros de validação Prisma (campo obrigatório nulo, tipo inválido, etc.)
  if (err.name === 'PrismaClientValidationError') {
    logger.warn({ event: 'prisma.validation_error', path: req?.path, err: err.message?.slice(0, 200) });
    return res.status(400).json({ error: 'Dados inválidos para a operação no banco de dados.' });
  }
  if (err.name === 'PrismaClientKnownRequestError') {
    logger.warn({ event: 'prisma.known_error', code: err.code, path: req?.path, err: err.message?.slice(0, 200) });
    return res.status(400).json({ error: `Erro de banco de dados (${err.code}).` });
  }
  // Banco offline ou sem pool de conexão disponível → 503
  if (
    err.name === 'PrismaClientInitializationError' ||
    err.name === 'PrismaClientRustPanicError' ||
    err.message?.includes('closed the connection') ||   // P1017
    err.message?.includes("Can't reach database") ||    // P1001
    err.message?.includes('pool timeout') ||             // P2024
    err.message?.includes('ECONNREFUSED') ||
    err.message?.includes('ETIMEDOUT') ||
    err.message?.includes('Connection refused')
  ) {
    logger.warn({ event: 'db.unavailable', path: req?.path, errName: err.name, err: err.message?.slice(0, 200) });
    return res.status(503).json({ error: 'Banco de dados temporariamente indisponível. Tente novamente em instantes.' });
  }

  // Erros de timeout do AbortController
  if (err.name === 'AbortError') {
    return res.status(504).json({ error: 'Operação cancelada por timeout.' });
  }

  // Erro interno não mapeado
  logger.error({
    event:   'http.unhandled_error',
    path:    req.path,
    method:  req.method,
    userId:  req.user?.id,
    err:     err.message,
    stack:   process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });

  res.status(500).json({ error: 'Erro interno do servidor.' });
}

/** Cria um erro HTTP rápido */
function createError(message, statusCode = 400) {
  const err    = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { errorHandler, createError };
