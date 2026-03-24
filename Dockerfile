# ── Build stage ───────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Gerar Prisma Client
RUN npx prisma generate

# ── Runtime stage ─────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app
ENV NODE_ENV=production

# Copiar apenas o necessário
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

# Expor porta
EXPOSE 3001

# Entrypoint: force schema sync THEN start
CMD ["dumb-init", "sh", "-c", "npx prisma db push --accept-data-loss && node src/index.js"]
