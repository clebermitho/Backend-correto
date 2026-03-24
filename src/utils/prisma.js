const { PrismaClient } = require('@prisma/client');

// Singleton — evita múltiplas conexões em hot-reload
const prisma = global._prisma || new PrismaClient({
  datasources: {
    db: {
      url: process.env.DIRECT_URL || process.env.DATABASE_URL,
    },
  },
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
});
if (process.env.NODE_ENV !== 'production') global._prisma = prisma;

module.exports = { prisma };
