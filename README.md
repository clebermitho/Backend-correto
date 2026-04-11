# Chatplay Backend v1.0.0

Backend central do **Chatplay Assistant** — Node.js + Express + Prisma + PostgreSQL.

---

## Setup rápido (local)

```bash
cd chatplay-backend
npm run setup        # instala deps, cria .env, configura BD e seed interativo
npm run dev          # servidor em http://localhost:3001
```

### Pré-requisitos
- Node.js >= 20
- PostgreSQL >= 14 (local ou via Docker)

### Com Docker (recomendado)
```bash
cp .env.docker .env        # editar JWT_SECRET, OPENAI_API_KEY
docker-compose up -d       # sobe postgres + backend + admin
```

---

## Variáveis de ambiente obrigatórias

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Connection string PostgreSQL |
| `JWT_SECRET` | Segredo para assinar JWTs (≥ 64 chars aleatórios) |
| `OPENAI_API_KEY` | Chave OpenAI (fica **APENAS** no servidor) |
| `ADMIN_BOOTSTRAP_SECRET` | Segredo para `POST /api/auth/register` |

---

## Scripts

| Comando | Descrição |
|---|---|
| `npm run dev` | Desenvolvimento com nodemon |
| `npm start` | Produção |
| `npm run setup` | Configuração inicial interativa |
| `npm run db:migrate` | Nova migration Prisma (dev) |
| `npm run db:deploy` | Aplicar migrations (produção/CI) |
| `npm run db:seed` | Popular dados de teste |
| `npm run db:reset` | Reset completo (dev) |
| `npm run db:studio` | Prisma Studio (UI do BD) |

---

## Endpoints

### Auth
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/register` | Bootstrap do primeiro admin |
| POST | `/api/auth/login` | Login → Bearer token |
| POST | `/api/auth/logout` | Revogar sessão |
| GET | `/api/auth/me` | Usuário autenticado |

### IA (OpenAI centralizado — extensão nunca vê a chave)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/ai/suggestions` | Gera 3 sugestões de resposta |
| POST | `/api/ai/chat` | Chat livre com a IA |

### Sugestões & Feedback
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/suggestions` | Lista por categoria |
| POST | `/api/feedback` | Registra aprovação/reprovação |
| GET | `/api/feedback/rejected` | Lista reprovadas |

### Eventos & Métricas
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/events` | Registra evento de uso |
| GET | `/api/metrics/summary` | Resumo 30 dias (admin) |
| GET | `/api/metrics/activity` | Série temporal |

### Administração
| Método | Rota | Descrição |
|---|---|---|
| GET/POST/PATCH | `/api/users` | Gestão de agentes |
| GET/PUT | `/api/settings/:key` | Configurações da org |
| GET/POST/DELETE | `/api/templates` | Templates de resposta |
| GET/POST | `/api/knowledge-bases` | Bases de conhecimento |

### Contrato canônico de base de conhecimento
- Fonte principal: `https://raw.githubusercontent.com/clebermitho/knowledge-base/main/base-conhecimento.json`
- O backend prioriza contexto unificado (`KNOWLEDGE_CONTEXT`) para prompts.
- Placeholders legados (`BASE_COREN`, `BASE_SISTEMA`) continuam aceitos para compatibilidade de overrides existentes.

---

## Arquitetura de segurança

```
Extensão Chrome
    │
    ├── POST /api/auth/login   → Bearer token JWT
    ├── POST /api/ai/suggestions  → IA via backend (sem expor OPENAI_KEY)
    ├── POST /api/feedback         → feedback centralizado
    └── POST /api/events           → auditoria

Backend (Node.js:3001)
    │
    ├── OPENAI_API_KEY (apenas aqui)
    ├── PostgreSQL (Prisma)
    ├── JWT com sessões revogáveis
    └── Rate limiting + Helmet
```

**Princípio:** A `OPENAI_API_KEY` nunca sai do servidor. A extensão usa tokens JWT para autenticar.

---

## Estrutura

```
chatplay-backend/
├── prisma/
│   ├── schema.prisma     ← 8 modelos
│   ├── seed.js           ← dados de teste
│   └── migrations/       ← migrations SQL versionadas
├── eval/                 ← [Fase 2] Fundação de avaliação de qualidade
│   ├── datasets/         ← Datasets de referência (JSON)
│   └── README.md         ← Documentação de avaliação
├── scripts/
│   ├── setup.sh          ← setup interativo
│   └── reset-db.sh       ← reset dev
├── src/
│   ├── index.ts          ← entry point (monta /api/* e /api/v1/*)
│   ├── config/           ← env.ts, cors.ts, rateLimiter.ts, swagger.ts
│   ├── routes/
│   │   ├── auth, ai, events, suggestions, feedback, ... (legado /api/*)
│   │   └── v1/           ← [Fase 2] API versionada com envelope padrão
│   │       ├── index.ts  ← v1 router
│   │       └── ai.ts     ← /api/v1/ai/suggestions, /api/v1/ai/chat
│   ├── middleware/
│   │   ├── auth.ts       ← JWT + roles
│   │   ├── errorHandler.ts ← [Fase 2] traceId + buildErrorEnvelope
│   │   └── dbHealthGuard.ts
│   ├── services/
│   │   ├── openai.ts     ← transporte HTTP para OpenAI (legado, não alterar)
│   │   ├── aiOrchestrator.ts ← [Fase 2] camada central: fallback, custo, log
│   │   ├── promptRegistry.ts ← [Fase 2] versionamento de prompts
│   │   └── evaluation.ts     ← [Fase 2] fundação de avaliação
│   └── utils/
│       ├── sanitize.ts   ← [Fase 2] proteção contra prompt injection
│       ├── prisma.ts, jwt.ts, audit.ts, cache.ts, logger.ts
├── tests/                ← jest + babel
│   ├── services/         ← aiOrchestrator.test.js, evaluation.test.js
│   ├── utils/            ← sanitize.test.js, jwt.test.js
│   └── middleware/       ← auth.test.js, errorHandler.test.js
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## API Versionada (/api/v1)

A partir da Fase 2, novos endpoints são expostos sob `/api/v1/*` com envelope padrão:

**Sucesso:**
```json
{ "success": true, "data": { ... }, "traceId": "uuid" }
```

**Erro:**
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Cota mensal de IA excedida.",
    "details": null,
    "traceId": "uuid"
  }
}
```

### Endpoints v1 disponíveis

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/v1/ai/suggestions` | Sugestões com fallback, custo estimado, sanitização |
| POST | `/api/v1/ai/chat` | Chat com fallback, custo estimado, sanitização |

Os endpoints legados `/api/ai/*` permanecem sem alteração para compatibilidade.

---

## Novas variáveis de ambiente (Fase 2)

| Variável | Descrição | Padrão |
|---|---|---|
| `OPENAI_MODEL` | Modelo primário da OpenAI | `gpt-4o-mini` |
| `AI_FALLBACK_MODEL` | Modelo de fallback (timeout/rate-limit/provider error) | `gpt-4o-mini` |
