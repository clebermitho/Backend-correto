import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../utils/logger';

/** Standard error codes returned in every error response.
 *  Clients should use `code` for programmatic handling; `error` is kept for
 *  backward compatibility until all consumers migrate to the v1 contract. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'DAILY_LIMIT_EXCEEDED'
  | 'UPSTREAM_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

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
 * Builds a standard v1 error response envelope for /api/v1 routes.
 * Legacy /api/* routes use the flat `{ error, code, traceId }` shape via `errorBody`.
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
      traceId: req?.headers?.['x-request-id'] as string | undefined,
    },
  };
}

/** Extract the traceId from the request (set by the correlation-id middleware in index.ts). */
function getTraceId(req: Request): string | undefined {
  const id = req?.headers?.['x-request-id'];
  return typeof id === 'string' ? id : undefined;
}

/** Build a consistent error response body.
 *  - `error`   : kept for backward compat with existing clients.
 *  - `code`    : machine-readable error classification (new).
 *  - `traceId` : correlation ID for log lookup (new).
 *  - `details` : optional structured details (e.g. Zod issues).
 */
function errorBody(
  message: string,
  code: ErrorCode,
  traceId: string | undefined,
  details?: unknown,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error:   message,
    code,
    traceId,
  };
  if (details !== undefined) body.details = details;
  return body;
}

/**
 * Middleware global de tratamento de erros.
 * Deve ser registrado ÚLTIMO no app.use().
 *
 * Backward-compatible: existing routes receive `{ error, code, traceId }`.
 * traceId is propagated from the correlation-id middleware (non-breaking addition).
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const traceId = getTraceId(req);

  // Erros de validação Zod — 400 Bad Request
  if (err instanceof ZodError) {
    const issues = err.errors.map(e => ({ path: e.path.join('.'), message: e.message }));
    logger.warn({
      event:  'validation.failed',
      path:   req.path,
      traceId,
      issues,
    });
    res.status(400).json({
      ...errorBody('Dados inválidos.', 'VALIDATION_ERROR', traceId),
      issues,
    });
    return;
  }

  const e = err as Record<string, unknown>;

  // Erros conhecidos com statusCode
  if (e.statusCode) {
    const status = e.statusCode as number;
    if (status >= 500) {
      logger.error({ event: 'http.error', status, msg: e.message,
                     path: req.path, method: req.method, userId: req.user?.id, traceId });
    }
    const code = httpStatusToCode(status, e);
    res.status(status).json(errorBody(e.message as string, code, traceId));
    return;
  }

  // Erros do Prisma
  if (e.code === 'P2002') {
    res.status(409).json(errorBody('Registro duplicado.', 'CONFLICT', traceId));
    return;
  }
  if (e.code === 'P2025') {
    res.status(404).json(errorBody('Registro não encontrado.', 'NOT_FOUND', traceId));
    return;
  }
  if (e.code === 'P2003') {
    res.status(400).json(errorBody('Referência inválida: registro relacionado não encontrado.', 'INVALID_REQUEST', traceId));
    return;
  }
  if (e.code === 'P2000') {
    res.status(400).json(errorBody('Valor muito longo para o campo.', 'VALIDATION_ERROR', traceId));
    return;
  }
  if (e.code === 'P1008' || e.code === 'P2024') {
    res.status(503).json(errorBody('Banco de dados sobrecarregado. Tente novamente.', 'SERVICE_UNAVAILABLE', traceId));
    return;
  }
  if (e.code === 'P1001' || e.code === 'P1002') {
    res.status(503).json(errorBody('Banco de dados indisponível. Tente novamente.', 'SERVICE_UNAVAILABLE', traceId));
    return;
  }
  // Erros de validação Prisma (campo obrigatório nulo, tipo inválido, etc.)
  if (e.name === 'PrismaClientValidationError') {
    logger.warn({ event: 'prisma.validation_error', path: req?.path, traceId, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(400).json(errorBody('Dados inválidos para a operação no banco de dados.', 'VALIDATION_ERROR', traceId));
    return;
  }
  if (e.name === 'PrismaClientKnownRequestError') {
    if (e.code === 'P2022') {
      const meta = e.meta as Record<string, unknown> | undefined;
      logger.error({ event: 'prisma.missing_column', meta, path: req?.path, traceId });
      res.status(500).json(errorBody(
        `Erro de esquema: a coluna '${meta?.column}' não foi encontrada no banco de dados. O sistema tentará sincronizar no próximo reinício.`,
        'INTERNAL_ERROR',
        traceId,
      ));
      return;
    }
    logger.warn({ event: 'prisma.known_error', code: e.code, path: req?.path, traceId, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(400).json(errorBody(`Erro de banco de dados (${e.code}).`, 'INVALID_REQUEST', traceId));
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
    logger.warn({ event: 'db.unavailable', path: req?.path, traceId, errName: e.name, err: typeof e.message === 'string' ? (e.message as string).slice(0, 200) : undefined });
    res.status(503).json(errorBody('Banco de dados temporariamente indisponível. Tente novamente em instantes.', 'SERVICE_UNAVAILABLE', traceId));
    return;
  }

  // Erros de timeout do AbortController
  if (e.name === 'AbortError') {
    res.status(504).json(errorBody('Operação cancelada por timeout.', 'TIMEOUT', traceId));
    return;
  }

  // Erro interno não mapeado
  logger.error({
    event:  'http.unhandled_error',
    path:   req.path,
    method: req.method,
    userId: req.user?.id,
    traceId,
    err:    e.message,
    stack:  process.env.NODE_ENV !== 'production' ? e.stack : undefined,
  });

  res.status(500).json(errorBody('Erro interno do servidor.', 'INTERNAL_ERROR', traceId));
}

/** Map HTTP status code to ErrorCode (for errors thrown with statusCode) */
function httpStatusToCode(status: number, e: Record<string, unknown>): ErrorCode {
  // Allow errors to carry an explicit code (for future typed errors)
  if (typeof e.errorCode === 'string') return e.errorCode as ErrorCode;
  switch (status) {
    case 400: return 'INVALID_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: {
      // Distinguish quota/limit errors from permission errors
      const msg = String(e.message || '');
      if (msg.includes('Limite diário')) return 'DAILY_LIMIT_EXCEEDED';
      if (msg.includes('Cota mensal'))   return 'RATE_LIMIT_EXCEEDED';
      return 'FORBIDDEN';
    }
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 429: return 'RATE_LIMIT_EXCEEDED';
    case 502: return 'UPSTREAM_ERROR';
    case 503: return 'SERVICE_UNAVAILABLE';
    case 504: return 'TIMEOUT';
    default:  return status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
  }
}

/** Cria um erro HTTP rápido */
export function createError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}
