jest.mock('../src/utils/prisma', () => require('./mocks/prisma'));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/utils/audit', () => ({ log: jest.fn() }));
jest.mock('../src/utils/jwt', () => ({
  createSession: jest.fn(),
  createRefreshToken: jest.fn(),
  revokeSession: jest.fn(),
  refreshAccessToken: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const authRoutes = require('../src/routes/auth');
const { prisma } = require('./mocks/prisma');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Auth Endpoints', () => {
  it('should return 401 for invalid login', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'wrong@example.com',
        password: 'wrongpassword'
      });
    expect(res.statusCode).toEqual(401);
    expect(res.body).toHaveProperty('error');
  });
});