import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

let _dbOnline = true;
const DB_CHECK_INTERVAL = 30_000;

export async function checkDbHealth(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    if (!_dbOnline) {
      logger.info({ event: 'db.reconnected', msg: 'Conexão com o banco de dados restabelecida.' });
    }
    _dbOnline = true;
  } catch (err: unknown) {
    if (_dbOnline) {
      logger.error({
        event: 'db.disconnected',
        msg: 'Conexão com o banco de dados perdida.',
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    _dbOnline = false;
  }
}

checkDbHealth();
setInterval(checkDbHealth, DB_CHECK_INTERVAL);

const DB_EXEMPT = ['/api/auth/login', '/api/auth/register', '/api/auth/me', '/health', '/api-docs'];

export function dbHealthGuard(req: Request, res: Response, next: NextFunction): void {
  const isExempt = DB_EXEMPT.some(p => {
    const pathWithoutApi = req.path.startsWith('/api') ? req.path : `/api${req.path}`;
    return pathWithoutApi.startsWith(p);
  });

  if (!_dbOnline && !isExempt) {
    res.status(503).json({
      error:  'Banco de dados temporariamente indisponível. Tente novamente em instantes.',
      detail: 'O servidor está aguardando reconexão com o banco de dados (Supabase). Verifique o DATABASE_URL no Render.',
      retryAfter: 30,
    });
    return;
  }
  next();
}
