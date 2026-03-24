require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const { prisma }  = require('./utils/prisma');
const logger      = require('./utils/logger');
const { errorHandler }     = require('./middleware/errorHandler');
const { cleanExpiredSessions } = require('./utils/jwt');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

// ── Swagger Configuration ────────────────────────────────────
const swaggerOptions = {
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
  apis: ['./src/routes/*.js'], // Caminho para os arquivos de rotas com anotações JSDoc
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

// ── CORS — configurado ANTES de helmet e de tudo mais ────────
// ⚠️  IMPORTANTE: O cors() precisa ser o PRIMEIRO middleware para que
//    erros de preflight (OPTIONS) e respostas de erro também incluam
//    os headers Access-Control-Allow-Origin corretos.

const extraOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

// Origens sempre permitidas (hardcoded + extras do .env)
const ALWAYS_ALLOWED = [
  'https://chatplay.com.br',
  'https://backend-assistant-0x1d.onrender.com', // self-requests
  'https://assistant-chat-if83.onrender.com',     // painel admin no Render
  'https://admin-assistant-chat.onrender.com',    // URL alternativa do admin
  'http://localhost:5173',                         // admin dev (Vite)
  'http://localhost:3000',
  'http://localhost:3001',
];
const allowedOrigins = [...new Set([...ALWAYS_ALLOWED, ...extraOrigins])];

const corsOptions = {
  origin: (origin, callback) => {
    // Sem Origin: Postman, curl, service workers, requests internos → OK
    if (!origin) return callback(null, true);

    // Extensões Chrome/Edge → sempre permitir (autenticadas por JWT Bearer)
    if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
      return callback(null, true);
    }

    // Origens permitidas
    if (allowedOrigins.some(o => origin === o || origin.startsWith(o))) {
      return callback(null, true);
    }

    // Bloquear origin desconhecida
    logger.warn({ event: 'cors.blocked', origin });
    callback(new Error(`CORS: origem não permitida — ${origin}`));
  },
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-Token-Expires'],
  maxAge: 86400, // cache preflight por 24h
};

// Aplicar CORS globalmente — responde a OPTIONS automaticamente
app.use(cors(corsOptions));

// Handler explícito para OPTIONS (preflight) — garante 200 mesmo antes do auth
app.options('*', cors(corsOptions));

// ── Segurança e parsers ──────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // necessário para extensões
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// ── Logging de requisições HTTP ──────────────────────────────
app.use((req, res, next) => {
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
  windowMs:  15 * 60 * 1000, // 15 min
  max:        10,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});

// AI limiter por usuário — 60 req/min para comportar equipes maiores
const aiLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:        60,
  message: { error: 'Limite de requisições de IA atingido. Aguarde 1 minuto.' },
  keyGenerator: (req) => req.user?.id || req.ip,
});

app.use('/api', globalLimiter);
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/ai',            aiLimiter);

// ── Middleware: DB Health Guard ──────────────────────────────
// Bloqueia /api/* com 503 quando o banco está offline (detectado periodicamente)
let _dbOnline = true;
let _dbCheckTs = 0;
const DB_CHECK_INTERVAL = 30_000; // 30s

async function checkDbHealth() {
  try {
    // Tenta uma query simples de conexão
    await prisma.$queryRaw`SELECT 1`;
    if (!_dbOnline) {
      logger.info({ event: 'db.reconnected', msg: 'Conexão com o banco de dados restabelecida.' });
    }
    _dbOnline = true;
  } catch (err) {
    if (_dbOnline) {
      logger.error({ 
        event: 'db.disconnected', 
        msg: 'Conexão com o banco de dados perdida.', 
        error: err.message?.slice(0, 200) 
      });
    }
    _dbOnline = false;
  }
  _dbCheckTs = Date.now();
}
// Verificação inicial e recorrente
checkDbHealth();
setInterval(checkDbHealth, DB_CHECK_INTERVAL);

// Rotas que DEVEM funcionar mesmo com banco offline (para permitir login/carregamento básico)
const DB_EXEMPT = ['/api/auth/login', '/api/auth/register', '/api/auth/me', '/health', '/api-docs'];

app.use('/api', (req, res, next) => {
  // Se banco offline e rota não é exempta, retornar 503
  const isExempt = DB_EXEMPT.some(p => {
    const pathWithoutApi = req.path.startsWith('/api') ? req.path : `/api${req.path}`;
    return pathWithoutApi.startsWith(p);
  });

  if (!_dbOnline && !isExempt) {
    return res.status(503).json({
      error:  'Banco de dados temporariamente indisponível. Tente novamente em instantes.',
      detail: 'O servidor está aguardando reconexão com o banco de dados (Supabase). Verifique o DATABASE_URL no Render.',
      retryAfter: 30,
    });
  }
  next();
});

// ── Rotas ────────────────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api/auth',            require('./routes/auth'));
app.use('/api/events',          require('./routes/events'));
app.use('/api/suggestions',     require('./routes/suggestions'));
app.use('/api/feedback',        require('./routes/feedback'));
app.use('/api/metrics',         require('./routes/metrics'));
app.use('/api/settings',        require('./routes/settings'));
app.use('/api/ai',              require('./routes/ai'));
app.use('/api/templates',       require('./routes/templates'));
app.use('/api/users',           require('./routes/users'));
app.use('/api/knowledge-bases', require('./routes/knowledgeBases'));

// ── Health check — verifica DB real ─────────────────────────
app.get('/health', async (req, res) => {
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
  } catch (dbErr) {
    logger.error({ event: 'health.db_error', err: dbErr.message });
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
app.use((req, res) => {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.path}` });
});

// ── Error handler global ─────────────────────────────────────
app.use(errorHandler);

// ── Graceful shutdown ────────────────────────────────────────
async function shutdown(signal) {
  logger.info({ event: 'shutdown.signal', signal });
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

const { execSync } = require('child_process');

// ... (resto dos imports)

// ── Start ────────────────────────────────────────────────────
async function start() {
  try {
    const dbUrl = process.env.DATABASE_URL || '';
    const directUrl = process.env.DIRECT_URL || '';
    const mask = (url) => url.replace(/:([^@]+)@/, ':****@');

    logger.info({ event: 'startup.env_check', databaseUrl: mask(dbUrl), directUrl: mask(directUrl) });

    // Tenta sincronizar o banco de dados via código para garantir que as colunas existam
    if (directUrl) {
      try {
        logger.info({ event: 'startup.db_sync_start', info: 'Sincronizando esquema com DIRECT_URL...' });
        execSync('npx prisma db push --accept-data-loss', {
          env: { ...process.env, DATABASE_URL: directUrl },
          stdio: 'inherit'
        });
        logger.info({ event: 'startup.db_sync_ok' });
      } catch (syncErr) {
        logger.error({ event: 'startup.db_sync_failed', err: syncErr.message });
      }
    }

    await prisma.$connect();
    logger.info({ event: 'startup.db_connected' });
  } catch (err) {
    logger.error({ event: 'startup.db_failed', err: err.message });
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info({
      event:        'startup.server_ready',
      port:         PORT,
      env:          ENV,
      health:       `http://localhost:${PORT}/health`,
      version:      '1.1.0',
      allowedCors:  allowedOrigins,
    });
  });

  // Limpeza de sessões expiradas a cada 1h
  setInterval(async () => {
    try {
      const count = await cleanExpiredSessions();
      if (count > 0) logger.info({ event: 'cleanup.sessions', removed: count });
    } catch (err) {
      logger.warn({ event: 'cleanup.sessions_error', err: err.message });
    }
  }, 3600 * 1000);
}

start();
module.exports = app;
