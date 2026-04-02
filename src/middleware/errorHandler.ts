import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../utils/logger';

// ── Standard error envelope (used by /api/v1 routes) ────────

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
  traceId?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorEnvelope;
}

/**
 * Builds a standard error response envelope for /api/v1 routes.
 * Legacy /api/* routes still use the flat `{ error: string }` shape.
 */
export function buildErrorEnvelope(
  code: string,
  message: string,
  req: Request,
  details?: unknown
): ApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      details,
      traceId: (req.headers['x-request-id'] as string | undefined),
    },
  };
}

/** Extracts the traceId from the request (added by the correlation-id middleware). */
function getTraceId(req: Request): string | undefined {
  return req?.headers?.['x-request-id'] as string | undefined;
}

/**
 * Middleware global de tratamento de erros.
 * Deve ser registrado ÚLTIMO no app.use().
 *
 * Backward-compatible: existing routes continue to receive `{ error: string }`.
 * traceId is added as an additional field to all responses (non-breaking).
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const traceId = getTraceId(req);

  // Erros de validação Zod — 400 Bad Request
  if (err instanceof ZodError) {
    logger.warn({
      event:   'validation.failed',
      path:    req.path,
      traceId,
      issues:  err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
    res.status(400).json({
      error:   'Dados inválidos.',
      issues:  err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
      traceId,
    });
    return;
  }

  const e = err as Record<string, unknown>;

  // Erros conhecidos com statusCode
  if (e.statusCode) {
    if ((e.statusCode as number) >= 500) {
      logger.error({ event: 'http.error', status: e.statusCode, msg: e.message,
                     path: req.path, method: req.method, userId: req.user?.id, traceId });
    }
    res.status(e.statusCode as number).json({ error: e.message, traceId });
    return;
  }

  // Erros do Prisma
  if (e.code === 'P2002') {
    res.status(409).json({ error: 'Registro duplicado.', traceId });
    return;
  }
  if (e.code === 'P2025') {
    res.status(404).json({ error: 'Registro não encontrado.', traceId });
    return;
  }
  if (e.code === 'P2003') {
    res.status(400).json({ error: 'Referência inválida: registro relacionado não encontrado.', traceId });
    return;
  }
  if (e.code === 'P2000') {
    res.status(400).json({ error: 'Valor muito longo para o campo.', traceId });
    return;
  }
  if (e.code === 'P1008' || e.code === 'P2024') {
    res.status(503).json({ error: 'Banco de dados sobrecarregado. Tente novamente.', traceId });
    return;
  }
  if (e.code === 'P1001' || e.code === 'P1002') {
    res.status(503).json({ error: 'Banco de dados indisponível. Tente novamente.', traceId });
    return;
  }
  // Erros de validação Prisma (campo obrigatório nulo, tipo inválido, etc.)
  if (e.name === 'PrismaClientValidationError') {
    logger.warn({ event: 'prisma.validation_error', path: req?.path, traceId, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(400).json({ error: 'Dados inválidos para a operação no banco de dados.', traceId });
    return;
  }
  if (e.name === 'PrismaClientKnownRequestError') {
    if (e.code === 'P2022') {
      const meta = e.meta as Record<string, unknown> | undefined;
      logger.error({ event: 'prisma.missing_column', meta, path: req?.path, traceId });
      res.status(500).json({ error: `Erro de esquema: a coluna '${meta?.column}' não foi encontrada no banco de dados. O sistema tentará sincronizar no próximo reinício.`, traceId });
      return;
    }
    logger.warn({ event: 'prisma.known_error', code: e.code, path: req?.path, traceId, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(400).json({ error: `Erro de banco de dados (${e.code}).`, traceId });
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
    logger.warn({ event: 'db.unavailable', path: req?.path, errName: e.name, traceId, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(503).json({ error: 'Banco de dados temporariamente indisponível. Tente novamente em instantes.', traceId });
    return;
  }

  // Erros de timeout do AbortController
  if (e.name === 'AbortError') {
    res.status(504).json({ error: 'Operação cancelada por timeout.', traceId });
    return;
  }

  // Erro interno não mapeado
  logger.error({
    event:   'http.unhandled_error',
    path:    req.path,
    method:  req.method,
    userId:  req.user?.id,
    traceId,
    err:     e.message,
    stack:   process.env.NODE_ENV !== 'production' ? e.stack : undefined,
  });

  res.status(500).json({ error: 'Erro interno do servidor.', traceId });
}

/** Cria um erro HTTP rápido */
export function createError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}
