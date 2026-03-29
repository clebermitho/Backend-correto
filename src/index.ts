import 'dotenv/config';
import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Prisma } from '@prisma/client';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { prisma } from './utils/prisma';
import logger from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { cleanExpiredSessions } from './utils/jwt';
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

// ── Swagger Configuration ────────────────────────────────────
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Chatplay Assistant API',
      version: '1.2.0',
      description: 'API central do ecossistema Chatplay Assistant — Node.js + Express + Prisma + PostgreSQL',
    },
    servers: [
      { url: `http://localhost:${process.env.PORT || 3001}`, description: 'Servidor de Desenvolvimento' },
      { url: 'https://backend-assistant-0x1d.onrender.com', description: 'Servidor de Produção' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [path.join(__dirname, 'routes', '*.js')],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// ── Validação de variáveis de ambiente obrigatórias ──────────
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  logger.error({ event: 'startup.missing_env', vars: missing });
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  logger.warn({ event: 'startup.no_openai_key', msg: 'OPENAI_API_KEY não configurada — endpoints de IA desabilitados.' });
}
if (!process.env.ADMIN_BOOTSTRAP_SECRET) {
  logger.warn({ event: 'startup.no_bootstrap_secret', msg: 'ADMIN_BOOTSTRAP_SECRET não configurada — /api/auth/register bloqueado.' });
}

const app  = express();
const PORT = parseInt(process.env.PORT || '3001');
const ENV  = process.env.NODE_ENV || 'development';

// ── Trust proxy (necessário no Render) ───────────────────────
app.set('trust proxy', 1);

// ── CORS ─────────────────────────────────────────────────────
const extraOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

const ALWAYS_ALLOWED = [
  'https://chatplay.com.br',
  'https://backend-assistant-0x1d.onrender.com',
  'https://assistant-chat-if83.onrender.com',
  'https://admin-assistant-chat.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
];
const allowedOrigins = [...new Set([...ALWAYS_ALLOWED, ...extraOrigins])];

const corsOptions: cors.CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);

    if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
      return callback(null, true);
    }

    if (allowedOrigins.some(o => origin === o || origin.startsWith(o))) {
      return callback(null, true);
    }

    logger.warn({ event: 'cors.blocked', origin });
    callback(new Error(`CORS: origem não permitida — ${origin}`));
  },
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-Token-Expires'],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

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
const globalLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:        200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' },
  skip: (req) => req.path === '/health',
});

const authLimiter = rateLimit({
  windowMs:  15 * 60 * 1000,
  max:        10,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});

const aiLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:        60,
  message: { error: 'Limite de requisições de IA atingido. Aguarde 1 minuto.' },
  keyGenerator: (req) => (req.user as { id?: string } | undefined)?.id || req.ip || 'unknown',
});

app.use('/api', globalLimiter);
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/ai',            aiLimiter);

// ── Middleware: DB Health Guard ──────────────────────────────
let _dbOnline = true;
const DB_CHECK_INTERVAL = 30_000;

async function checkDbHealth(): Promise<void> {
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
        error: (err instanceof Error ? err.message : String(err))?.slice(0, 200),
      });
    }
    _dbOnline = false;
  }
}
checkDbHealth();
setInterval(checkDbHealth, DB_CHECK_INTERVAL);

const DB_EXEMPT = ['/api/auth/login', '/api/auth/register', '/api/auth/me', '/health', '/api-docs'];

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
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
});

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

// ── Health check — verifica DB real ─────────────────────────
app.get('/health', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status:  'ok',
      version: '1.1.0',
      env:     ENV,
      db:      'connected',
      uptime:  Math.round(process.uptime()),
      latency: Date.now() - startTime,
      ts:      new Date().toISOString(),
    });
  } catch (dbErr: unknown) {
    logger.error({ event: 'health.db_error', err: dbErr instanceof Error ? dbErr.message : String(dbErr) });
    res.status(503).json({
      status:  'degraded',
      version: '1.1.0',
      db:      'disconnected',
      error:   'Banco de dados indisponível.',
      ts:      new Date().toISOString(),
    });
  }
});

// ── 404 ──────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.path}` });
});

// ── Error handler global ─────────────────────────────────────
app.use(errorHandler);

// ── Graceful shutdown ────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info({ event: 'shutdown.signal', signal });
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ────────────────────────────────────────────────────
async function start() {
  try {
    const dbUrl    = process.env.DATABASE_URL || '';
    const directUrl = process.env.DIRECT_URL  || '';
    const mask = (url: string) => url.replace(/:([^@]+)@/, ':****@');

    logger.info({ event: 'startup.env_check', databaseUrl: mask(dbUrl), directUrl: mask(directUrl) });

    await prisma.$connect();
    logger.info({ event: 'startup.db_connected' });
  } catch (err: unknown) {
    logger.error({ event: 'startup.db_failed', err: (err as Error).message });
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info({
      event:       'startup.server_ready',
      port:        PORT,
      env:         ENV,
      health:      `http://localhost:${PORT}/health`,
      version:     '1.1.0',
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
