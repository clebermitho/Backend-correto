# Checklist de Homologação — Chatplay Assistant v1.1

> Executar antes do piloto interno.
> Status: ✅ OK | ❌ Falhou | ⚠️ Parcial | ⬜ Não testado

---

## 1. Autenticação

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 1.1 | Login com credenciais corretas | JWT + refreshToken retornados | ⬜ | |
| 1.2 | Login com senha errada | HTTP 401 "Credenciais inválidas" | ⬜ | |
| 1.3 | Login com e-mail inexistente | HTTP 401 (sem revelar se existe) | ⬜ | |
| 1.4 | Login com usuário inativo | HTTP 401 | ⬜ | |
| 1.5 | GET /auth/me com token válido | `{ user: {...} }` com dados corretos | ⬜ | |
| 1.6 | GET /auth/me com token inválido | HTTP 401 | ⬜ | |
| 1.7 | GET /auth/me após logout | HTTP 401 (sessão revogada) | ⬜ | |
| 1.8 | POST /auth/refresh com refreshToken válido | Novo accessToken | ⬜ | |
| 1.9 | POST /auth/refresh com token expirado | HTTP 401 | ⬜ | |
| 1.10 | 10+ tentativas de login em 15min | Rate limit (HTTP 429) | ⬜ | |

---

## 2. Extensão — Fluxo de login/logout

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 2.1 | Popup sem token → tela de login | Formulário visível | ⬜ | |
| 2.2 | Login correto no popup | Dashboard com nome do usuário | ⬜ | |
| 2.3 | Sessão expirada (token velho) | Tela "Sessão expirada" | ⬜ | |
| 2.4 | Botão logout | Volta para tela de login | ⬜ | |
| 2.5 | Backend offline + token presente | Dashboard modo degradado (stats locais) | ⬜ | |
| 2.6 | URL do backend errada | Mensagem de erro clara no popup | ⬜ | |
| 2.7 | Ping backend → botão Ping | ✓ ok / ✗ err | ⬜ | |

---

## 3. IA — Geração de Sugestões

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 3.1 | Gerar sugestões com mensagem do cliente | 3 sugestões retornadas em < 10s | ⬜ | |
| 3.2 | Sugestões registradas no banco | `GET /api/suggestions` retorna registros | ⬜ | |
| 3.3 | Evento `ai.suggestions_generated` criado | `GET /api/events` mostra evento | ⬜ | |
| 3.4 | Backend offline durante geração | Mensagem "serviço indisponível" (sem tela branca) | ⬜ | |
| 3.5 | OpenAI com erro (key inválida) | Erro legível para o usuário | ⬜ | |

---

## 4. Feedback de Sugestões

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 4.1 | Clicar em sugestão (escolher) | Feedback USED enviado ao backend | ⬜ | |
| 4.2 | Rejeitar sugestão | Feedback REJECTED enviado ao backend | ⬜ | |
| 4.3 | Score da sugestão atualizado | `GET /api/suggestions` mostra score > 0 | ⬜ | |
| 4.4 | Feedback duplicado do mesmo user+type | Idempotente — 200 sem duplicar | ⬜ | |
| 4.5 | GET /feedback/rejected | Retorna apenas da mesma org | ⬜ | |

---

## 5. Chat IA

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 5.1 | Enviar mensagem no chat | Resposta em < 15s | ⬜ | |
| 5.2 | Evento `ai.chat_message` criado | Visível em /events | ⬜ | |

---

## 6. Configurações (Settings)

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 6.1 | GET /api/settings (agente) | Retorna settings da org | ⬜ | |
| 6.2 | PUT /api/settings/:key (admin) | Atualiza e persiste | ⬜ | |
| 6.3 | PUT /api/settings/:key (agente) | HTTP 403 | ⬜ | |
| 6.4 | Settings carregadas no boot da extensão | CONFIG refletido no Core | ⬜ | |

---

## 7. Admin — Usuários

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 7.1 | Listar usuários (admin) | Retorna lista da org | ⬜ | |
| 7.2 | Criar novo agente | Usuário criado, senha hasheada | ⬜ | |
| 7.3 | Criar usuário com e-mail duplicado | HTTP 409 | ⬜ | |
| 7.4 | Desativar usuário | isActive=false, próximo login bloqueado | ⬜ | |
| 7.5 | Admin tentar desativar a si mesmo | HTTP 400 "Não é possível desativar sua conta" | ⬜ | |
| 7.6 | Listar usuários (agente) | HTTP 403 | ⬜ | |
| 7.7 | Resetar senha | Sessões anteriores revogadas | ⬜ | |

---

## 8. Admin — Templates

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 8.1 | Listar templates (admin) | Lista da org | ⬜ | |
| 8.2 | Criar template | Template salvo | ⬜ | |
| 8.3 | Deletar template | isActive=false (soft delete) | ⬜ | |
| 8.4 | Template desativado não aparece no GET | Correto | ⬜ | |

---

## 9. Admin — Métricas/Dashboard

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 9.1 | Dashboard carrega em < 3s | Dados visíveis sem erro | ⬜ | |
| 9.2 | Gráfico de atividade 7 dias | Barras renderizadas | ⬜ | |
| 9.3 | Contagem de usuários ativos | Condizente com cadastro | ⬜ | |
| 9.4 | Agente tenta acessar /metrics/summary | HTTP 403 | ⬜ | |

---

## 10. Admin — Eventos (Auditoria)

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 10.1 | Página Eventos carrega | Lista de eventos recentes | ⬜ | |
| 10.2 | Filtro "Erros" | Apenas eventos error.* | ⬜ | |
| 10.3 | Filtro "IA" | Apenas eventos ai.* | ⬜ | |
| 10.4 | Filtro "Autenticação" | Apenas eventos auth.* | ⬜ | |
| 10.5 | Summary 24h visível | Agrupamento por tipo | ⬜ | |

---

## 11. Health check e resiliência

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 11.1 | GET /health com banco UP | `{"status":"ok","db":"connected"}` | ⬜ | |
| 11.2 | GET /health com banco DOWN | `{"status":"degraded","db":"disconnected"}` (HTTP 503) | ⬜ | |
| 11.3 | Requisição a rota inexistente | HTTP 404 com mensagem clara | ⬜ | |
| 11.4 | Payload inválido em qualquer rota | HTTP 400 com detalhes Zod | ⬜ | |
| 11.5 | 200+ req/min (rate limit global) | HTTP 429 | ⬜ | |

---

## 12. Multi-usuário simultâneo

| # | Cenário | Esperado | Status | Observação |
|---|---------|----------|--------|------------|
| 12.1 | 2 agentes gerando sugestões ao mesmo tempo | Ambos recebem sugestões sem conflito | ⬜ | |
| 12.2 | Agente A não vê dados do Agente B de outra org | Isolamento por organizationId | ⬜ | |
| 12.3 | Session do Agente A válida enquanto B faz logout | Sessões independentes | ⬜ | |

---

## Resultado Final

| Categoria | Total | ✅ OK | ❌ Falhou | ⚠️ Parcial | ⬜ Não testado |
|---|---|---|---|---|---|
| Autenticação | 10 | | | | 10 |
| Extensão login/logout | 7 | | | | 7 |
| IA - Sugestões | 5 | | | | 5 |
| Feedback | 5 | | | | 5 |
| Chat IA | 2 | | | | 2 |
| Settings | 4 | | | | 4 |
| Usuários | 7 | | | | 7 |
| Templates | 4 | | | | 4 |
| Métricas | 4 | | | | 4 |
| Eventos | 5 | | | | 5 |
| Health/Resiliência | 5 | | | | 5 |
| Multi-usuário | 3 | | | | 3 |
| **TOTAL** | **61** | | | | **61** |

---

## Critério de aprovação para piloto

- Zero itens ❌ em categorias 1, 2, 3, 7 (críticas)
- No máximo 3 itens ⚠️ Parcial no total
- Itens ⬜ apenas em cenários opcionais/edge-case

