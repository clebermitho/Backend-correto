const router = require('express').Router();
const { z }  = require('zod');
const { requireAuth }            = require('../middleware/auth');
const { generateSuggestions, generateChatReply } = require('../services/openai');
const { prisma }                 = require('../utils/prisma');
const { log }                    = require('../utils/audit');
const logger                     = require('../utils/logger');

// ── Auxiliar: Verificar e descontar quota ────────────────────
async function checkQuota(orgId) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { monthlyQuota: true, usedTokens: true, name: true }
  });

  if (!org) throw new Error('Organização não encontrada.');
  
  if (org.usedTokens >= org.monthlyQuota) {
    logger.warn({ event: 'ai.quota_exceeded', orgId, orgName: org.name });
    const err = new Error('Cota mensal de IA excedida para sua organização.');
    err.statusCode = 403;
    throw err;
  }
  return org;
}

async function updateQuota(orgId, tokens) {
  await prisma.organization.update({
    where: { id: orgId },
    data: { usedTokens: { increment: tokens } }
  });
}

// POST /api/ai/suggestions — extensão envia contexto, recebe 3 sugestões
router.post('/suggestions', requireAuth, async (req, res, next) => {
  try {
    await checkQuota(req.organizationId);
    
    const schema = z.object({
      context:       z.string().min(1),
      question:      z.string().min(1),
      category:      z.string().default('OUTROS'),
      topExamples:   z.array(z.string()).default([]),
      avoidPatterns: z.array(z.string()).default([]),
    });

    const data = schema.parse(req.body);

    const settingsRows = await prisma.setting.findMany({
      where:  { organizationId: req.organizationId },
      select: { key: true, value: true },
    });
    const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    const learnFromApproved = settings['suggestion.learnFromApproved'] !== undefined
      ? Boolean(settings['suggestion.learnFromApproved'])
      : true;
    const filterRejected = settings['suggestion.filterRejected'] !== undefined
      ? Boolean(settings['suggestion.filterRejected'])
      : true;

    const model = typeof settings['suggestion.model'] === 'string'
      ? settings['suggestion.model']
      : undefined;

    const temperature = settings['suggestion.temperature'] !== undefined
      ? Number(settings['suggestion.temperature'])
      : 0.2;

    const maxTokens = settings['suggestion.maxTokens'] !== undefined
      ? Number(settings['suggestion.maxTokens'])
      : 500;

    const promptTemplate = typeof settings['prompt.suggestions'] === 'string'
      ? settings['prompt.suggestions']
      : '';

    // Buscar bases de conhecimento ativas da org
    const kbs = await prisma.knowledgeBase.findMany({
      where: { organizationId: req.organizationId, isActive: true },
    });
    const knowledgeBases = Object.fromEntries(kbs.map(kb => [kb.name, kb.content]));

    const topExamples = learnFromApproved
      ? (await prisma.template.findMany({
          where: {
            organizationId: req.organizationId,
            isActive: true,
            category: data.category,
          },
          select: { text: true },
          orderBy: [{ score: 'desc' }, { usageCount: 'desc' }, { updatedAt: 'desc' }],
          take: 3,
        })).map(t => t.text).filter(Boolean)
      : [];

    const avoidPatterns = filterRejected
      ? (await prisma.suggestionFeedback.findMany({
          where: {
            type: 'REJECTED',
            suggestion: { organizationId: req.organizationId, category: data.category },
          },
          select: { suggestion: { select: { text: true } } },
          orderBy: { createdAt: 'desc' },
          take: 15,
        }))
          .map(r => r.suggestion?.text)
          .filter(Boolean)
          .map(t => String(t).trim().slice(0, 80))
          .filter(Boolean)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .slice(0, 5)
      : [];

    const result = await generateSuggestions({
      ...data,
      topExamples,
      avoidPatterns,
      knowledgeBases,
      promptTemplate,
      model,
      temperature,
      maxTokens,
    });

    // Atualizar quota
    if (result.tokensUsed) {
      await updateQuota(req.organizationId, result.tokensUsed);
    }

    // Salvar no banco automaticamente
    const saved = await prisma.$transaction(
      result.suggestions.map(text =>
        prisma.suggestion.create({
          data: { organizationId: req.organizationId, category: data.category, text, source: 'AI' },
        })
      )
    );

    log({
      organizationId: req.organizationId,
      userId:         req.user.id,
      eventType:      'ai.suggestions_generated',
      payload: {
        category:   data.category,
        count:      result.suggestions.length,
        latencyMs:  result.latencyMs,
        tokensUsed: result.tokensUsed,
      },
      req,
    });

    res.json({
      suggestions: saved.map((s, i) => ({ id: s.id, text: result.suggestions[i] })),
      latencyMs:   result.latencyMs,
      tokensUsed:  result.tokensUsed,
    });
  } catch (err) { 
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err); 
  }
});

// POST /api/ai/chat — chat livre com a IA (contexto + bases + system prompt)
router.post('/chat', requireAuth, async (req, res, next) => {
  try {
    await checkQuota(req.organizationId);

    const schema = z.object({
      message:      z.string().min(1),
      history:      z.array(z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })).default([]),
      context:      z.string().default(''),
      knowledge:    z.object({
        coren:   z.any().optional(),
        sistema: z.any().optional(),
      }).optional().default({}),
      systemPrompt: z.string().default(''),
    });

    const { message, history, context } = schema.parse(req.body);

    const settingsRows = await prisma.setting.findMany({
      where:  { organizationId: req.organizationId },
      select: { key: true, value: true },
    });
    const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    const model = typeof settings['suggestion.model'] === 'string'
      ? settings['suggestion.model']
      : undefined;

    const temperature = settings['suggestion.temperature'] !== undefined
      ? Number(settings['suggestion.temperature'])
      : 0.2;

    const maxTokens = settings['suggestion.maxTokens'] !== undefined
      ? Number(settings['suggestion.maxTokens'])
      : 600;

    const systemPromptTemplate = typeof settings['prompt.chat'] === 'string' && settings['prompt.chat'].trim().length > 0
      ? settings['prompt.chat']
      : '';

    // Buscar bases de conhecimento salvas no banco
    const kbs = await prisma.knowledgeBase.findMany({
      where: { organizationId: req.organizationId, isActive: true },
    });
    const dbKnowledgeBases = Object.fromEntries(kbs.map(kb => [kb.name, kb.content]));

    const result = await generateChatReply({
      message,
      history,
      context,
      systemPromptTemplate,
      dbKnowledgeBases,
      model,
      temperature,
      maxTokens,
    });

    // Atualizar quota
    if (result.tokensUsed) {
      await updateQuota(req.organizationId, result.tokensUsed);
    }

    log({
      organizationId: req.organizationId,
      userId:         req.user.id,
      eventType:      'ai.chat_message',
      payload: { latencyMs: result.latencyMs, tokensUsed: result.tokensUsed },
      req,
    });

    res.json({ reply: result.reply, latencyMs: result.latencyMs });
  } catch (err) { 
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err); 
  }
});

module.exports = router;
