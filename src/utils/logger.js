/**
 * logger.js — Logger estruturado para o Chatplay Backend
 *
 * Produção: JSON one-per-line (fácil ingestão por Datadog/CloudWatch/Loki)
 * Desenvolvimento: texto legível no console
 *
 * Uso:
 *   const logger = require('../utils/logger');
 *   logger.info({ event: 'auth.login', userId, ip });
 *   logger.warn({ event: 'rate_limit_hit', path: req.path });
 *   logger.error({ event: 'openai_error', err: err.message });
 */

const winston = require('winston');
const { DateTime } = require('luxon');

const IS_PROD = process.env.NODE_ENV === 'production';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Custom format for dev
const devFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  const ts = DateTime.fromISO(timestamp).toFormat('HH:mm:ss');
  const meta = Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : '';
  const icons = { info: '📋', warn: '⚠️ ', error: '❌', debug: '🔍' };
  return `${ts} ${icons[level] || '•'} [${level.toUpperCase()}] ${message}${meta}`;
});

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    IS_PROD ? winston.format.json() : winston.format.combine(winston.format.colorize(), devFormat)
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),
  ],
});

// Helper para requests (substitui morgan)
logger.request = (req, res, duration) => {
  const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
  logger.log(level, 'http.request', {
    method:     req.method,
    path:       req.path,
    status:     res.statusCode,
    durationMs: duration,
    ip:         req.ip || req.headers['x-forwarded-for'],
    userId:     req.user?.id,
  });
};

module.exports = logger;
