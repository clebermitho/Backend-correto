import cors from 'cors';
import logger from '../utils/logger';

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

export const allowedOrigins = [...new Set([...ALWAYS_ALLOWED, ...extraOrigins])];

export const corsOptions: cors.CorsOptions = {
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
