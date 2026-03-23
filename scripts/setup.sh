#!/usr/bin/env bash
set -euo pipefail
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*"; exit 1; }

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Chatplay Backend — Setup Local v1.0.0      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

node_ver=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
[ "${node_ver:-0}" -ge 20 ] || err "Necessário Node.js >= 20"
info "Node.js $(node -v)"

npm ci && info "Dependências instaladas"

if [ ! -f .env ]; then
    cp .env.example .env
    warn ".env criado — edite com DATABASE_URL, JWT_SECRET e OPENAI_API_KEY antes de continuar"
else
    info ".env já existe"
fi

source .env 2>/dev/null || true
[ -n "${DATABASE_URL:-}" ] || err "DATABASE_URL não configurada no .env"

npx prisma generate && info "Prisma Client gerado"

npx prisma migrate deploy 2>/dev/null || npx prisma db push
info "Banco configurado"

echo ""
read -p "Popular banco com dados de teste? (s/N) " -n 1 -r; echo ""
if [[ $REPLY =~ ^[Ss]$ ]]; then
    node prisma/seed.js && info "Seed executado"
fi

echo ""
echo "✅ Pronto! Execute: npm run dev"
echo "   Health: http://localhost:3001/health"
