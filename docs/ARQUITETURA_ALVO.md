# Fase 1 — Arquitetura Alvo: Backend (clebermitho/Backend-correto)

> Versão: 1.0  
> Data: 2026-04-02  
> Status: Aprovado para implementação incremental (Fases 2–6)

---

## 1. Visão Geral do Sistema (4 Repositórios)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         PRODUTO CHATPLAY                            │
│                                                                     │
│  ┌─────────────┐    ┌────────────────┐    ┌──────────────────────┐  │
│  │  Extensão   │    │  Admin Panel   │    │  Base de Conhecimento│  │
│  │ (thin client│    │  (gestão +     │    │  (pipeline de        │  │
│  │  browser)   │    │   auditoria)   │    │   ingestão/indexação)│  │
│  └──────┬──────┘    └───────┬────────┘    └──────────┬───────────┘  │
│         │                  │                         │              │
│         └──────────────────┴─────────────────────────┘              │
│                            │                                        │
│                     ┌──────▼──────┐                                 │
│                     │   BACKEND   │                                 │
│                     │ (orquestrador│                                │
│                     │  central)   │                                 │
│                     └──────┬──────┘                                 │
│                            │                                        │
│              ┌─────────────┴──────────────┐                         │
│              │                            │                         │
│       ┌──────▼──────┐            ┌────────▼────────┐                │
│       │  PostgreSQL  │            │   OpenAI API    │                │
│       │  (Prisma)    │            │   (LLM + embed) │                │
│       └─────────────┘            └─────────────────┘                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Responsabilidades por Repositório

### 2.1 Backend (este repositório) — Orquestrador Central

**Responsabilidades:**
- Autenticação e autorização (JWT multi-tenant, RBAC)
- Orquestração de chamadas LLM (único ponto de acesso à OpenAI)
- Gerenciamento de quotas, limites e billing de tokens
- Armazenamento e versionamento de prompt templates
- Execução de experimentos A/B em prompts/modelos
- Avaliação de qualidade de respostas (offline + online)
- Ingestão, indexação e servico de bases de conhecimento (RAG)
- Auditoria completa de ações (UsageEvent)
- API REST versionada (`/api/v1/`)
- Observabilidade: logs estruturados, métricas de IA, tracing por `traceId`

**NÃO é responsabilidade do Backend:**
- Renderização de UI
- Lógica de classificação de intenção (delegada ao LLM ou ao serviço semântico futuro)
- Sincronização de estado local da extensão

### 2.2 Admin Panel — Camada de Gestão

**Responsabilidades:**
- Dashboard de monitoramento de IA (latência, custo, erros, fallback)
- Gerenciamento de prompt templates (versões, publicação, rollback)
- Gerenciamento de bases de conhecimento (status de ingestão/indexação)
- Acompanhamento de experimentos A/B e métricas de qualidade
- Auditoria de ações críticas
- Gerenciamento de usuários, settings e quotas

### 2.3 Extensão — Cliente Fino (Thin Client)

**Responsabilidades:**
- Captura de contexto da conversa ativa
- Exibição de sugestões retornadas pelo Backend
- Cache local mínimo (TTL curto, invalidação por evento)
- Classificação de intenção **via API** (não mais localmente com heurísticas)
- Autenticação (JWT armazenado localmente com expiração)
- Tratamento de estados offline/erro com filas de retry

**NÃO é responsabilidade da Extensão:**
- Carregar base de conhecimento completa em JSON
- Chaves de API ou segredos
- Lógica de negócio pesada

### 2.4 Base de Conhecimento — Pipeline Desacoplado

**Responsabilidades:**
- Pipeline de ingestão (fontes externas: GitHub, URLs, uploads)
- Limpeza, chunking e normalização de conteúdo
- Versionamento de documentos (hash, data, origem)
- Atualização incremental e deduplicação
- Publicação de conteúdo indexado para o Backend consumir

---

## 3. Arquitetura Alvo do Backend

### 3.1 Estrutura de Diretórios Alvo

```
src/
├── index.ts                  Entry-point (inalterado)
├── config/
│   ├── env.ts                (existente)
│   ├── cors.ts               (existente)
│   ├── rateLimiter.ts        (existente)
│   ├── swagger.ts            (existente)
│   └── prompts/              ← NOVO: prompt templates versionados
│       ├── index.ts          Registro de versões e lookup por nome/versão
│       ├── suggestions-v1.ts Template padrão de sugestões (v1.0.0)
│       └── chat-v1.ts        Template padrão de chat (v1.0.0)
├── middleware/
│   ├── auth.ts               (existente)
│   ├── errorHandler.ts       (atualizado: +code, +traceId)
│   ├── dbHealthGuard.ts      (existente)
│   └── traceId.ts            ← NOVO: propaga x-request-id para req.traceId
├── routes/
│   ├── v1/                   ← NOVO: roteador versionado
│   │   └── index.ts          Monta todos os sub-routers sob /api/v1/
│   └── (rotas existentes mantidas — backward compatible)
├── services/
│   ├── openai.ts             (existente — mantido para compatibilidade)
│   └── llm/                  ← NOVO: abstração de orquestração LLM
│       ├── index.ts          Export público
│       ├── types.ts          Interfaces: LLMProvider, LLMCallOptions, LLMResult
│       ├── orchestrator.ts   Orquestrador: fallback, retry, observabilidade
│       └── providers/
│           └── openai.ts     Adapter OpenAI (envolve services/openai.ts)
└── utils/
    ├── prisma.ts             (existente)
    ├── jwt.ts                (existente)
    ├── audit.ts              (existente)
    ├── cache.ts              (existente)
    └── logger.ts             (existente)
```

### 3.2 Diagrama de Fluxo Alvo — Sugestões

```
Extensão
  → POST /api/v1/ai/suggestions (Bearer token)
    → traceId middleware (x-request-id → req.traceId)
    → requireAuth
    → checkQuota + checkDailyLimit
    → LLMOrchestrator.generate({
        type: 'suggestions',
        promptVersionId: resolveActivePrompt('suggestions', orgId),
        context: { context, question, category, topExamples, avoidPatterns, kbs },
        fallbackPolicy: { onTimeout: 'gpt-4o-mini-backup', onRateLimit: 'queue' },
      })
        → AICallLog.create (pré-call)
        → promptRegistry.render(version, vars)
        → primaryProvider.call() ──[falha]──→ fallbackProvider.call()
        → AICallLog.update (resultado + latência + tokens + fallbackUsed)
    → updateQuota
    → log() async
    → res.json({ suggestions, latencyMs, tokensUsed, traceId })
```

### 3.3 Novos Modelos Prisma

#### PromptVersion
Armazena versões de prompt com metadados completos para versionamento e A/B.

```prisma
model PromptVersion {
  id             String    @id @default(cuid())
  organizationId String?                        // null = global (padrão do sistema)
  name           String                         // ex: "suggestions", "chat"
  version        String                         // semver: "1.0.0"
  template       String                         // template com {{VARIÁVEIS}}
  isActive       Boolean   @default(false)      // apenas um ativo por (org, name)
  isDefault      Boolean   @default(false)      // fallback global
  changelog      String?
  owner          String?
  metadata       Json      @default("{}")       // ex: { "abGroup": "B", "model": "gpt-4o" }
  createdAt      DateTime  @default(now())
  activatedAt    DateTime?
  deactivatedAt  DateTime?

  @@index([organizationId, name])
  @@index([name, isActive])
  @@map("prompt_versions")
}
```

#### AICallLog
Log granular de chamadas LLM para observabilidade e análise de qualidade.

```prisma
model AICallLog {
  id               String    @id @default(cuid())
  organizationId   String
  userId           String?
  traceId          String?
  callType         String                         // suggestions | chat | embedding
  model            String
  promptVersionId  String?
  promptTokens     Int
  completionTokens Int
  totalTokens      Int
  cachedTokens     Int       @default(0)
  latencyMs        Int
  errorType        String?                        // null = success | timeout | rate_limit | provider_error
  errorMessage     String?
  fallbackUsed     Boolean   @default(false)
  retryCount       Int       @default(0)
  estimatedCostUsd Float?
  qualityScore     Float?                         // score da avaliação offline/online (Fase 2)
  createdAt        DateTime  @default(now())

  organization Organization @relation(fields: [organizationId], references: [id])

  @@index([organizationId, callType])
  @@index([traceId])
  @@index([createdAt])
  @@map("ai_call_logs")
}
```

---

## 4. Contratos de API Alvo

### 4.1 Formato Padrão de Resposta de Erro (v1)

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Dados inválidos.",
  "traceId": "550e8400-e29b-41d4-a716-446655440000",
  "details": [
    { "path": "context", "message": "String must contain at least 1 character(s)" }
  ]
}
```

**Catálogo de `code` values:**

| HTTP | code | Situação |
|------|------|----------|
| 400 | `VALIDATION_ERROR` | Zod/input inválido |
| 400 | `INVALID_REQUEST` | Lógica de negócio inválida |
| 401 | `UNAUTHORIZED` | Token ausente/inválido/expirado |
| 403 | `FORBIDDEN` | Permissão insuficiente ou quota excedida |
| 404 | `NOT_FOUND` | Recurso não encontrado |
| 409 | `CONFLICT` | Duplicata |
| 429 | `RATE_LIMIT_EXCEEDED` | Rate limit atingido |
| 429 | `DAILY_LIMIT_EXCEEDED` | Limite diário do usuário |
| 502 | `UPSTREAM_ERROR` | Erro do provedor de IA |
| 503 | `SERVICE_UNAVAILABLE` | DB ou serviço externo indisponível |
| 504 | `TIMEOUT` | Timeout de chamada externa |
| 500 | `INTERNAL_ERROR` | Erro interno não mapeado |

### 4.2 Contrato `/api/v1/ai/suggestions`

**Request:**
```json
{
  "context": "string (1-12000 chars)",
  "question": "string (1-2000 chars)",
  "category": "NEGOCIACAO | SUSPENSAO | CANCELAMENTO | DUVIDA | RECLAMACAO | OUTROS",
  "topExamples": ["string"],
  "avoidPatterns": ["string"]
}
```

**Response 200:**
```json
{
  "suggestions": [
    { "id": "cuid", "text": "string" }
  ],
  "latencyMs": 1234,
  "tokensUsed": 456,
  "model": "gpt-4o-mini",
  "promptVersionId": "cuid",
  "traceId": "uuid"
}
```

**Response Erro (ex: 429):**
```json
{
  "code": "DAILY_LIMIT_EXCEEDED",
  "message": "Limite diário de solicitações de sugestões atingido (10/10).",
  "traceId": "uuid"
}
```

### 4.3 Contrato `/api/v1/ai/chat`

**Request:**
```json
{
  "message": "string (1-4000 chars)",
  "history": [
    { "role": "user | assistant", "content": "string" }
  ]
}
```

**Response 200:**
```json
{
  "reply": "string",
  "latencyMs": 1234,
  "tokensUsed": 456,
  "model": "gpt-4o-mini",
  "traceId": "uuid"
}
```

---

## 5. Política de Fallback de LLM

### 5.1 Árvore de Decisão

```
Chamada LLM
    │
    ▼
Tentar modelo primário (ex: gpt-4o-mini)
    │
    ├── Sucesso → retornar resultado (fallbackUsed = false)
    │
    └── Falha
          │
          ├── timeout (ETIMEDOUT / AbortError)
          │       → retry 1x com timeout aumentado (1.5x)
          │       → se ainda falhar → fallback modelo secundário
          │
          ├── rate_limit (429 OpenAI)
          │       → esperar jitter (1-3s) → retry 2x
          │       → se ainda 429 → fallback modelo secundário
          │
          ├── provider_error (5xx OpenAI)
          │       → retry 3x com backoff exponencial (500ms base)
          │       → se ainda falhar → fallback modelo secundário
          │
          └── context_too_long (400 / context_length_exceeded)
                  → truncar contexto (50%) → retry com modelo primário
                  → se ainda falhar → retornar erro 400 CONTEXT_TOO_LONG
```

### 5.2 Configuração por Organização

```json
{
  "llm.primaryModel": "gpt-4o-mini",
  "llm.fallbackModel": "gpt-3.5-turbo",
  "llm.maxRetries": 3,
  "llm.timeoutMs": 30000,
  "llm.fallbackEnabled": true
}
```

---

## 6. Política de Versionamento de Prompts

### 6.1 Ciclo de Vida

```
DRAFT → ACTIVE → DEPRECATED
  │       │          │
  │       ▼          ▼
  │   (em uso)   (arquivo)
  │
  └── apenas SUPER_ADMIN ou ADMIN pode promover para ACTIVE
```

### 6.2 Regras

1. Apenas **1 versão pode estar ACTIVE** por `(organizationId, name)` ao mesmo tempo.
2. Toda mudança de prompt requer nova versão (imutabilidade de versões existentes).
3. Rollback = ativar versão anterior (audit log registra quem fez e quando).
4. A/B testing = 2 versões com `metadata.abGroup = "A" | "B"` + routing por user hash.

---

## 7. Plano de Migração (Backward Compatibility)

### 7.1 API Versioning

| Etapa | Ação | Risco |
|-------|------|-------|
| **Fase 1 (esta PR)** | Adicionar `/api/v1/*` (aliases) | Zero — additive |
| **Fase 2** | Implementar `/api/v1/*` com contratos completos (erros `code`, paginação, etc.) | Baixo |
| **Fase 3** | Migrar Extensão para `/api/v1/*` | Médio — coordenação com outro repo |
| **Fase 3** | Migrar Admin para `/api/v1/*` | Médio |
| **Fase 6** | Deprecar `/api/*` com sunset header | Baixo — clientes já migrados |

### 7.2 Erro Format Migration

- **Fase 1 (esta PR):** Todos os erros passam a incluir `code` e `traceId` **além do** campo `error` existente. Campo `error` mantido para backward compat.
- **Fase 2:** `/api/v1/*` retorna apenas novo formato. `/api/*` continua com ambos os campos.
- **Fase 6:** Remover campo `error` legado após todos os clientes migrarem.

### 7.3 Prompt Versionamento Migration

- **Fase 1 (esta PR):** Infraestrutura criada (modelos Prisma, serviço). Prompts default do sistema definidos como `PromptVersion` com `isDefault=true`.
- **Fase 2:** `routes/ai.ts` usa `PromptVersion` em vez de `settings['prompt.suggestions']`. Configuração anterior lida como override temporário.
- **Fase 3:** Settings de prompt legados deprecados em favor de `PromptVersion`.

---

## 8. Observabilidade Alvo

### 8.1 Métricas de IA a Implementar (Fase 2)

| Métrica | Fonte | Agregação |
|---------|-------|-----------|
| Latência P50/P95/P99 por `callType` | `AICallLog.latencyMs` | Por hora/dia |
| Taxa de erro por `callType` | `AICallLog.errorType != null` | Por hora/dia |
| Taxa de fallback | `AICallLog.fallbackUsed` | Por hora/dia |
| Custo estimado por org/dia | `AICallLog.estimatedCostUsd` | Diário |
| Tokens cached vs total | `AICallLog.cachedTokens / totalTokens` | Por dia |
| Score de qualidade | `AICallLog.qualityScore` | Por semana |

### 8.2 Logs Estruturados Alvo

```json
{
  "event": "llm.call.complete",
  "traceId": "uuid",
  "orgId": "cuid",
  "userId": "cuid",
  "callType": "suggestions",
  "model": "gpt-4o-mini",
  "promptVersion": "1.2.0",
  "latencyMs": 1234,
  "totalTokens": 456,
  "cachedTokens": 120,
  "fallbackUsed": false,
  "retryCount": 0,
  "estimatedCostUsd": 0.000068
}
```

---

## 9. Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| Breaking change na API quebra a extensão | Média | Alto | Manter `/api/*` sem mudanças; toda inovação em `/api/v1/*` |
| Migração de prompts perde configurações customizadas das orgs | Baixa | Médio | Ler settings legados como override até Phase 3 |
| Schema additions causam falha de deploy sem migration | Média | Alto | Executar `prisma migrate deploy` no pipeline CI antes de reiniciar |
| Custo de logs estruturados em `AICallLog` (volume alto) | Baixa | Baixo | Retenção configurável + cleanup job |
| Complexidade aumentada de `LLMOrchestrator` | Média | Médio | Interface mínima; sem abstração de multi-provider ainda |

---

## 10. Fases de Implementação Detalhadas (Backend)

| Fase | Escopo | Status |
|------|--------|--------|
| **Fase 0** | Diagnóstico técnico (`docs/DIAGNOSTICO.md`) | ✅ Concluído |
| **Fase 1** | Arquitetura alvo (`docs/ARQUITETURA_ALVO.md`) + infraestrutura base | ✅ Esta PR |
| **Fase 2** | API profissional, camada LLM, fallback, qualidade, A/B | 🔜 Próxima PR |
| **Fase 3** | Integração com novo Admin | 🔜 Depende de Fase 2 |
| **Fase 4** | Suporte à Extensão thin client | 🔜 Depende de Fase 2 |
| **Fase 5** | Pipeline de Base de Conhecimento | 🔜 Depende de Fase 2 |
| **Fase 6** | Hardening final | 🔜 Depende de Fases 2-5 |
