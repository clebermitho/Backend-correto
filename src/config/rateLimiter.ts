import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:        200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' },
  skip: (req) => req.path === '/health',
});

export const authLimiter = rateLimit({
  windowMs:  15 * 60 * 1000,
  max:        10,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});

export const aiLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:        60,
  message: { error: 'Limite de requisições de IA atingido. Aguarde 1 minuto.' },
  keyGenerator: (req) => (req.user as { id?: string } | undefined)?.id || req.ip || 'unknown',
});
