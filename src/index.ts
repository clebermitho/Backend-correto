import 'dotenv/config';
import { randomUUID } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Prisma } from '@prisma/client';
import compression from 'compression';
import swaggerUi from 'swagger-ui-express';
import { prisma } from './utils/prisma';
import logger from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { cleanExpiredSessions } from './utils/jwt';
import { env } from './config/env';
import { corsOptions, allowedOrigins } from './config/cors';
import { swaggerSpec } from './config/swagger';
import { globalLimiter, authLimiter, aiLimiter } from './config/rateLimiter';
import { dbHealthGuard } from './middleware/dbHealthGuard';
import authRouter from './routes/auth';
import eventsRouter from './routes/events';
import suggestionsRouter from './routes/suggestions';
import feedbackRouter from './routes/feedback';
import metricsRouter from './routes/metrics';
import settingsRouter from './routes/settings';
import aiRouter from './routes/ai';
import templatesRouter from './routes/templates';
import usersRouter from './routes/users';
import knowledgeBasesRouter from './routes/knowledgeBases';
import quotaRouter from './routes/quota';

const app = express();

// ── Trust proxy (necessário no Render) ───────────────────────
app.set('trust proxy', 1);

// ── Request ID (Correlation ID) ──────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  req.headers['x-request-id'] ??= randomUUID();
  res.setHeader('X-Request-Id', req.headers['x-request-id'] as string);
  next();
});

// ── CORS ─────────────────────────────────────────────────────
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── Helmet: desabilitar CSP para Swagger UI ──────────────────
app.use('/api-docs', helmet({ contentSecurityPolicy: false }));

// ── Segurança e parsers ──────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// ── Logging de requisições HTTP ──────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => logger.request(req, res, Date.now() - start));
  next();
});

// ── Rate limiting ────────────────────────────────────────────
app.use('/api', globalLimiter);
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/ai',            aiLimiter);

// ── Middleware: DB Health Guard ──────────────────────────────
app.use('/api', dbHealthGuard);

// ── Rotas ────────────────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api/auth',            authRouter);
app.use('/api/events',          eventsRouter);
app.use('/api/suggestions',     suggestionsRouter);
app.use('/api/feedback',        feedbackRouter);
app.use('/api/metrics',         metricsRouter);
app.use('/api/settings',        settingsRouter);
app.use('/api/ai',              aiRouter);
app.use('/api/templates',       templatesRouter);
app.use('/api/users',           usersRouter);
app.use('/api/knowledge-bases', knowledgeBasesRouter);
app.use('/api/quota',           quotaRouter);

// ── Health check robusto ─────────────────────────────────────
app.get('/health', async (req: Request, res: Response) => {
  const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'healthy' : 'degraded',
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
    version:   process.env.npm_package_version || '1.1.4',
    database:  dbOk ? 'connected' : 'disconnected',
  });
});

// ── 404 ──────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.path}` });
});

// ── Error handler global ─────────────────────────────────────
app.use(errorHandler);

// ── Avisos de startup ────────────────────────────────────────
if (!env.OPENAI_API_KEY) {
  logger.warn({ event: 'startup.no_openai_key', msg: 'OPENAI_API_KEY não configurada — endpoints de IA desabilitados.' });
}
if (!env.ADMIN_BOOTSTRAP_SECRET) {
  logger.warn({ event: 'startup.no_bootstrap_secret', msg: 'ADMIN_BOOTSTRAP_SECRET não configurada — /api/auth/register bloqueado.' });
}

// ── Graceful Shutdown ────────────────────────────────────────
let server: ReturnType<typeof app.listen> | undefined;

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: 'shutdown', signal });
  if (server) {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  } else {
    await prisma.$disconnect();
    process.exit(0);
  }
  setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    const mask = (url: string) => url.replace(/:([^@]+)@/, ':****@');
    logger.info({
      event:      'startup.env_check',
      databaseUrl: mask(env.DATABASE_URL),
      directUrl:  mask(process.env.DIRECT_URL || ''),
    });
    await prisma.$connect();
    logger.info({ event: 'startup.db_connected' });
  } catch (err: unknown) {
    logger.error({ event: 'startup.db_failed', err: (err as Error).message });
    process.exit(1);
  }

  server = app.listen(env.PORT, () => {
    logger.info({
      event:       'startup.server_ready',
      port:        env.PORT,
      env:         env.NODE_ENV,
      health:      `http://localhost:${env.PORT}/health`,
      version:     '1.1.4',
      allowedCors: allowedOrigins,
    });
  });

  // Limpeza de sessões expiradas a cada 1h
  setInterval(async () => {
    try {
      const count = await cleanExpiredSessions();
      if (count > 0) logger.info({ event: 'cleanup.sessions', removed: count });
    } catch (err: unknown) {
      logger.warn({ event: 'cleanup.sessions_error', err: (err as Error).message });
    }
  }, 3600 * 1000);

  const periodKeyUtc = () => {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  };

  const resetQuotaIfPeriodChanged = async () => {
    try {
      const period = periodKeyUtc();
      const orgs = await prisma.organization.findMany({
        select: { id: true, usedTokens: true },
      });
      if (orgs.length === 0) return;

      const settings = await prisma.setting.findMany({
        where: { key: 'quota.period' },
        select: { organizationId: true, value: true },
      });
      const prevByOrg = new Map(settings.map(s => [s.organizationId, String(s.value)]));

      const tx: Prisma.PrismaPromise<unknown>[] = [];
      for (const org of orgs) {
        const prev = prevByOrg.get(org.id);
        if (prev !== period) {
          tx.push(
            prisma.organization.update({
              where: { id: org.id },
              data: { usedTokens: 0 },
            })
          );
          tx.push(
            prisma.setting.upsert({
              where: { organizationId_key: { organizationId: org.id, key: 'quota.period' } },
              create: { organizationId: org.id, key: 'quota.period', value: period },
              update: { value: period },
            })
          );
        }
      }
      if (tx.length > 0) {
        await prisma.$transaction(tx);
        logger.info({ event: 'quota.reset', period, orgs: tx.length / 2 });
      }
    } catch (err: unknown) {
      logger.warn({ event: 'quota.reset_error', err: (err as Error).message });
    }
  };

  await resetQuotaIfPeriodChanged();
  setInterval(resetQuotaIfPeriodChanged, 6 * 3600 * 1000);
}

start();
export default app;
