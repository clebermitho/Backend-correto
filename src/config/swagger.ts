import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

const swaggerOptions: swaggerJsdoc.Options = {
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
  apis: [path.join(__dirname, '..', 'routes', '*.{ts,js}')],
};

export const swaggerSpec = swaggerJsdoc(swaggerOptions);
