const mockPrisma = {
  session: {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  organization: {
    upsert: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $disconnect: jest.fn(),
};

module.exports = { prisma: mockPrisma };
