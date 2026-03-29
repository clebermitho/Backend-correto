// Mock environment variables for testing
process.env.JWT_SECRET = 'test-secret-for-jest';
process.env.JWT_TTL_HOURS = '8';
process.env.JWT_REFRESH_DAYS = '30';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
