import winston from 'winston';
import { DateTime } from 'luxon';
import type { Request, Response } from 'express';

const IS_PROD = process.env.NODE_ENV === 'production';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const devFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  const ts = DateTime.fromISO(timestamp as string).toFormat('HH:mm:ss');
  const meta = Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : '';
  const icons: Record<string, string> = { info: '📋', warn: '⚠️ ', error: '❌', debug: '🔍' };
  return `${ts} ${icons[level] || '•'} [${level.toUpperCase()}] ${message}${meta}`;
});

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    IS_PROD
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), devFormat)
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),
  ],
});

(logger as winston.Logger & { request: (req: Request, res: Response, duration: number) => void }).request = (
  req: Request,
  res: Response,
  duration: number
) => {
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

export default logger as winston.Logger & { request: (req: Request, res: Response, duration: number) => void };
