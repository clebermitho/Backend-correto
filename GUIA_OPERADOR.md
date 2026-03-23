# Guia do Operador — Chatplay Assistant

> Para o supervisor / responsável técnico da implantação interna.
> Versão: 1.1.0 | Data: 2026-03

---

## 1. Primeira instalação

### Pré-requisitos
- Node.js 20+
- PostgreSQL 14+ (ou Docker)
- Conta OpenAI com chave de API

### Passo a passo

```bash
# 1. Ir para a pasta do backend
cd chatplay-backend

# 2. Copiar e preencher variáveis
cp .env.example .env
# Editar .env: DATABASE_URL, JWT_SECRET, OPENAI_API_KEY

# 3. Executar setup (instala, migra, seed opcional)
npm run setup

# 4. Iniciar o servidor
npm run dev       # desenvolvimento
npm start         # produção
```

### Com Docker (mais simples)

```bash
cp .env.docker .env
# Editar .env: JWT_SECRET, OPENAI_API_KEY, ADMIN_BOOTSTRAP_SECRET

docker-compose up -d
# Aguardar: backend está pronto quando GET http://localhost:3001/health retornar {"status":"ok"}
```

---

## 2. Criar o primeiro administrador

```bash
# Só funciona se ADMIN_BOOTSTRAP_SECRET estiver configurada no .env
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "name":          "Admin Principal",
    "email":         "admin@suaempresa.com.br",
    "password":      "SenhaForte@2026",
    "orgName":       "Coren-SP",
    "orgSlug":       "coren-sp",
    "adminSecret":   "VALOR_DO_ADMIN_BOOTSTRAP_SECRET"
  }'
```

---

## 3. Adicionar agentes

Acesse o painel admin → Usuários → criar usuário com papel "AGENT".

Ou via API:
```bash
curl -X POST http://localhost:3001/api/users \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Nome Agente","email":"agente@empresa.com","password":"Senha@123","role":"AGENT"}'
```

---

## 4. Instalar a extensão para agentes

1. Abrir Chrome/Edge → `chrome://extensions`
2. Ativar **Modo do desenvolvedor** (canto superior direito)
3. Clicar em **Carregar sem compactação**
4. Selecionar a pasta `chatplay-extension/`
5. A extensão aparecerá com o ícone CA

**Configurar cada agente:**
1. Clicar no ícone CA na barra do navegador
2. Em "URL do Backend", preencher com `http://IP_DO_SERVIDOR:3001`
3. Salvar
4. Digitar e-mail e senha → Entrar

---

## 5. Operação diária

| Situação | Ação |
|---|---|
| Agente esqueceu a senha | Admin → Usuários → redefinir senha |
| Extensão diz "sessão expirada" | Agente clica em "Fazer login novamente" |
| Backend offline | Verificar `docker-compose ps` / `npm start` |
| Sugestões não aparecem | Verificar `/health` e chave OpenAI no .env |
| Erros frequentes | Admin Panel → Eventos → filtro "Erros" |

---

## 6. Health check

```bash
curl http://localhost:3001/health
# Resposta esperada: {"status":"ok","db":"connected",...}
```

---

## 7. Backup do banco

```bash
# Dump manual
pg_dump -U chatplay chatplay_db > backup_$(date +%Y%m%d).sql

# Restaurar
psql -U chatplay chatplay_db < backup_20260318.sql
```

Com Docker:
```bash
docker exec chatplay_postgres pg_dump -U chatplay chatplay_db > backup_$(date +%Y%m%d).sql
```

---

## 8. Suporte / diagnóstico

Se algo der errado:

1. Verificar `GET /health` → se 503, problema de banco
2. Ver logs: `docker-compose logs -f backend` ou `npm run dev`
3. Verificar painel admin → Eventos → últimas 24h
4. Conferir `.env`: DATABASE_URL, JWT_SECRET, OPENAI_API_KEY preenchidos?
