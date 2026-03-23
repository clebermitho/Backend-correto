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
├── scripts/
│   ├── setup.sh          ← setup interativo
│   └── reset-db.sh       ← reset dev
├── src/
│   ├── index.js          ← entry point
│   ├── routes/           ← auth, ai, events, suggestions, feedback, metrics, users, settings, templates, knowledgeBases
│   ├── middleware/        ← auth (JWT), errorHandler
│   ├── services/         ← openai.js (proxy centralizado)
│   └── utils/            ← prisma, jwt, audit
├── Dockerfile
├── docker-compose.yml
└── .env.example
```
