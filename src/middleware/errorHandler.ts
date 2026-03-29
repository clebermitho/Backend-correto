import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../utils/logger';

/**
 * Middleware global de tratamento de erros.
 * Deve ser registrado ÚLTIMO no app.use().
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Erros de validação Zod — 400 Bad Request
  if (err instanceof ZodError) {
    logger.warn({
      event:  'validation.failed',
      path:   req.path,
      issues: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
    res.status(400).json({
      error:  'Dados inválidos.',
      issues: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
    return;
  }

  const e = err as Record<string, unknown>;

  // Erros conhecidos com statusCode
  if (e.statusCode) {
    if ((e.statusCode as number) >= 500) {
      logger.error({ event: 'http.error', status: e.statusCode, msg: e.message,
                     path: req.path, method: req.method, userId: req.user?.id });
    }
    res.status(e.statusCode as number).json({ error: e.message });
    return;
  }

  // Erros do Prisma
  if (e.code === 'P2002') {
    res.status(409).json({ error: 'Registro duplicado.' });
    return;
  }
  if (e.code === 'P2025') {
    res.status(404).json({ error: 'Registro não encontrado.' });
    return;
  }
  if (e.code === 'P2003') {
    res.status(400).json({ error: 'Referência inválida: registro relacionado não encontrado.' });
    return;
  }
  if (e.code === 'P2000') {
    res.status(400).json({ error: 'Valor muito longo para o campo.' });
    return;
  }
  if (e.code === 'P1008' || e.code === 'P2024') {
    res.status(503).json({ error: 'Banco de dados sobrecarregado. Tente novamente.' });
    return;
  }
  if (e.code === 'P1001' || e.code === 'P1002') {
    res.status(503).json({ error: 'Banco de dados indisponível. Tente novamente.' });
    return;
  }
  // Erros de validação Prisma (campo obrigatório nulo, tipo inválido, etc.)
  if (e.name === 'PrismaClientValidationError') {
    logger.warn({ event: 'prisma.validation_error', path: req?.path, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(400).json({ error: 'Dados inválidos para a operação no banco de dados.' });
    return;
  }
  if (e.name === 'PrismaClientKnownRequestError') {
    if (e.code === 'P2022') {
      const meta = e.meta as Record<string, unknown> | undefined;
      logger.error({ event: 'prisma.missing_column', meta, path: req?.path });
      res.status(500).json({ error: `Erro de esquema: a coluna '${meta?.column}' não foi encontrada no banco de dados. O sistema tentará sincronizar no próximo reinício.` });
      return;
    }
    logger.warn({ event: 'prisma.known_error', code: e.code, path: req?.path, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(400).json({ error: `Erro de banco de dados (${e.code}).` });
    return;
  }
  // Banco offline ou sem pool de conexão disponível → 503
  if (
    e.name === 'PrismaClientInitializationError' ||
    e.name === 'PrismaClientRustPanicError' ||
    typeof e.message === 'string' && (
      (e.message as string).includes('closed the connection') ||
      (e.message as string).includes("Can't reach database") ||
      (e.message as string).includes('pool timeout') ||
      (e.message as string).includes('ECONNREFUSED') ||
      (e.message as string).includes('ETIMEDOUT') ||
      (e.message as string).includes('Connection refused')
    )
  ) {
    logger.warn({ event: 'db.unavailable', path: req?.path, errName: e.name, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(503).json({ error: 'Banco de dados temporariamente indisponível. Tente novamente em instantes.' });
    return;
  }

  // Erros de timeout do AbortController
  if (e.name === 'AbortError') {
    res.status(504).json({ error: 'Operação cancelada por timeout.' });
    return;
  }

  // Erro interno não mapeado
  logger.error({
    event:  'http.unhandled_error',
    path:   req.path,
    method: req.method,
    userId: req.user?.id,
    err:    e.message,
    stack:  process.env.NODE_ENV !== 'production' ? e.stack : undefined,
  });

  res.status(500).json({ error: 'Erro interno do servidor.' });
}

/** Cria um erro HTTP rápido */
export function createError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}
