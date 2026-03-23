#!/usr/bin/env bash
set -euo pipefail
echo "⚠️  Apagará TODOS os dados. Confirma? (s/N)"
read -n 1 -r; echo ""
[[ $REPLY =~ ^[Ss]$ ]] || { echo "Cancelado."; exit 0; }
npx prisma migrate reset --force
node prisma/seed.js
echo "✅ Banco resetado com dados de teste."
