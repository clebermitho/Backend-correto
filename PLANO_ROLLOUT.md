# Plano de Rollout — Chatplay Assistant v1.1

---

## Estágio 0 — Homologação Interna (atual)

**Duração:** 1 semana  
**Participantes:** 1–2 responsáveis técnicos + supervisor

**Objetivo:** Validar todos os 61 itens do checklist de homologação.

**Critério de saída:**  
- Checklist aprovado conforme critério definido  
- Pelo menos 1 sessão de uso real em ambiente de teste

---

## Estágio 1 — Piloto Controlado

**Duração:** 2–3 semanas  
**Participantes:** 3–5 agentes voluntários (selecionar perfis diferentes)

**Ambiente:** servidor interno (não produção) ou Docker local

**Checklist de instalação por agente:**
- [ ] Extensão instalada no Chrome/Edge
- [ ] URL do backend configurada no popup
- [ ] Login realizado com sucesso
- [ ] Pelo menos 1 sugestão gerada e usada
- [ ] Agente entendeu como rejeitar uma sugestão

**Suporte:**
- Canal direto com o responsável técnico
- Formulário simples de feedback (Google Forms ou similar)

**O que monitorar:**
- Erros no painel admin → Eventos → filtro "Erros"  
- Latência das sugestões (campo `latencyMs` nos eventos)  
- Taxa de uso vs. rejeição de sugestões  
- Dificuldades reportadas pelos agentes

---

## Estágio 2 — Expansão Controlada

**Duração:** 2–4 semanas  
**Participantes:** 10–20 agentes

**Pré-requisitos:**
- Piloto Estágio 1 concluído sem problemas críticos  
- Servidor em ambiente estável (não laptop/local)  
- Backup de banco configurado  
- Pelo menos 1 admin capacitado para gestão do painel

**Critérios de saída do Estágio 1 para o 2:**
- Taxa de escolha de sugestão ≥ 40%  
- Zero erros críticos (HTTP 500) por dia por agente  
- Latência média de sugestão ≤ 5 segundos  
- Nenhum agente reportou perda de dados ou bug bloqueante

---

## Estágio 3 — Rollout Geral

**Participantes:** Todos os agentes da equipe  
**Ambiente:** Servidor de produção (hospedado)

**Pré-requisitos:**
- Estágio 2 aprovado  
- Backup diário automatizado  
- Processo de suporte definido  
- Documentação de uso disponível para agentes

---

## Métricas de Sucesso do Piloto

### Adoção
| Métrica | Fórmula | Meta Piloto |
|---|---|---|
| Taxa de ativação | agentes que usaram / total instalado | ≥ 80% |
| Sessões por agente/dia | total sessões / agentes ativos | ≥ 3 |
| Sugestões geradas/dia | total eventos ai.suggestions_generated / dias | > 10 |

### Qualidade das Sugestões
| Métrica | Fórmula | Meta Piloto |
|---|---|---|
| Taxa de escolha | feedbacks USED / sugestões geradas | ≥ 35% |
| Taxa de rejeição | feedbacks REJECTED / sugestões geradas | ≤ 30% |
| Score médio das sugestões | média do campo `score` no banco | > 0.5 ao final do piloto |

### Técnica
| Métrica | Como medir | Meta Piloto |
|---|---|---|
| Latência média IA | campo `latencyMs` nos eventos | ≤ 5.000ms |
| Erros por dia | eventos com eventType = error.* | ≤ 2/dia |
| Disponibilidade | tempo sem resposta do /health | ≥ 99% no horário comercial |

### Custo (referência)
| Métrica | Como calcular |
|---|---|
| Tokens por sugestão | média de `tokensUsed` nos eventos `ai.suggestions_generated` |
| Custo estimado/dia | tokens/dia × preço por token OpenAI |
| Economia por reaproveitamento | sugestões de template vs. IA: se template usado, custo = 0 |

---

## Fluxo de Suporte em Caso de Erro

```
Agente reporta problema
    │
    ├── Extensão não abre / não conecta
    │       └── Verificar URL do backend no popup → Ping
    │
    ├── "Serviço de IA indisponível"
    │       └── Admin: GET /health → checar OpenAI key no .env
    │
    ├── "Sessão expirada" sem conseguir reconectar
    │       └── Admin: resetar senha do agente em Usuários
    │
    ├── Sugestões muito ruins / fora de contexto
    │       └── Admin: revisar base de conhecimento + templates
    │
    └── Qualquer outra coisa
            └── Admin: Eventos → últimas 24h → identificar padrão
                → se recorrente, abrir issue técnica
```

---

## Backlog v1.1 (pós-piloto)

Itens identificados durante a análise mas fora do escopo do piloto:

| Item | Prioridade | Justificativa |
|---|---|---|
| Sincronização de histórico de atendimento com backend | Média | Volume alto; localStorage ainda funciona para v1 |
| Score local vs. backend reconciliado em tempo real | Baixa | LWW atual não conflita, mas pode divergir |
| Options Page na extensão para config BACKEND_URL | Média | Popup funciona, mas Options seria mais prático |
| Fila offline para eventos quando backend cai | Média | Hoje eventos são perdidos se backend estiver down |
| Notificação push de configuração remota | Baixa | Útil quando admin atualiza settings org |
| Página de Base de Conhecimento no admin | Média | Existe a rota, falta a UI |
| Export de sugestões/feedback em CSV | Baixa | Útil para análise mas não crítico |
| Autenticação SSO / LDAP | Baixa | Para times maiores futuramente |

---

## Riscos Identificados para o Piloto

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| OpenAI fora do ar | Baixa | Alto | Mensagem clara + modo offline de templates |
| Agente configurar URL errada do backend | Alta | Médio | Botão Ping + mensagem clara no popup |
| Banco PostgreSQL sem backup | Média | Alto | Executar `pg_dump` manual antes do piloto |
| Sessão expirar durante atendimento | Média | Médio | Refresh token automático (implementado) |
| Token JWT vazar (e-mail) | Baixa | Alto | Token em chrome.storage (não no DOM) |
