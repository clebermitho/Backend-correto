const { prisma } = require('./prisma');

/**
 * log — registra um UsageEvent no banco.
 * Chamada fire-and-forget: não bloqueia a resposta HTTP.
 */
async function log({ organizationId, userId = null, eventType, payload = {}, req = null }) {
  try {
    await prisma.usageEvent.create({
      data: {
        organizationId,
        userId,
        eventType,
        payload,
        ipAddress: req ? (req.ip || req.headers['x-forwarded-for']) : null,
        userAgent: req ? req.headers['user-agent'] : null,
      },
    });
  } catch (err) {
    console.error('[Audit] Falha ao registrar evento:', err.message);
  }
}

module.exports = { log };
