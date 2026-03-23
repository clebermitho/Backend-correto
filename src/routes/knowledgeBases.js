const router = require('express').Router();
const { z }  = require('zod');
const { prisma }      = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { log }         = require('../utils/audit');
const logger          = require('../utils/logger');
const { generateEmbedding } = require('../services/openai');

// ── Auxiliar: Gerar embedding p/ conteúdo JSON ───────────────
async function processEmbedding(content) {
  try {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return await generateEmbedding(text);
  } catch (err) {
    logger.error({ event: 'kb.embedding_failed', err: err.message });
    return null;
  }
}

// ── GET /api/knowledge-bases ─────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const kbs = await prisma.knowledgeBase.findMany({
      where:   { organizationId: req.organizationId, isActive: true },
      select:  { id: true, name: true, sourceUrl: true, lastSyncedAt: true, updatedAt: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    res.json({ knowledgeBases: kbs });
  } catch (err) { next(err); }
});

// ── POST /api/knowledge-bases — criar ou atualizar base ──────
router.post('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const data = z.object({
      id:        z.string().optional(),
      name:      z.string().min(2),
      sourceUrl: z.string().url().optional().nullable(),
      content:   z.record(z.unknown()).optional(),
    }).parse(req.body);

    let content = data.content || {};

    // Se tem sourceUrl e sem conteúdo manual, busca remotamente
    if (data.sourceUrl && !data.content) {
      try {
        const resp = await fetch(data.sourceUrl, { signal: AbortSignal.timeout(10_000) });
        if (resp.ok) content = await resp.json().catch(() => ({}));
        else logger.warn({ event: 'kb.fetch_failed', sourceUrl: data.sourceUrl, status: resp.status });
      } catch (fetchErr) {
        logger.warn({ event: 'kb.fetch_error', sourceUrl: data.sourceUrl, err: fetchErr.message });
        // Continua sem conteúdo remoto — não bloqueia a criação
      }
    }

    let kb;
    if (data.id) {
      // Atualizar existente (verificar ownership)
      const existing = await prisma.knowledgeBase.findFirst({
        where: { id: data.id, organizationId: req.organizationId },
      });
      if (!existing) return res.status(404).json({ error: 'Base de conhecimento não encontrada.' });

      kb = await prisma.knowledgeBase.update({
        where: { id: data.id },
        data:  { name: data.name, sourceUrl: data.sourceUrl, content, lastSyncedAt: new Date() },
      });
    } else {
      // Criar nova
      kb = await prisma.knowledgeBase.create({
        data: {
          organizationId: req.organizationId,
          name:           data.name,
          sourceUrl:      data.sourceUrl,
          content,
          lastSyncedAt:   new Date(),
        },
      });
    }

    // ── Atualizar Embedding Vector (via RAW SQL para pgvector) ──
    if (content) {
      const vector = await processEmbedding(content);
      if (vector) {
        await prisma.$executeRawUnsafe(
          `UPDATE knowledge_bases SET embedding = '[${vector.join(',')}]'::vector WHERE id = $1`,
          kb.id
        ).catch(e => logger.error({ event: 'kb.vector_save_error', err: e.message }));
      }
    }

    log({ organizationId: req.organizationId, userId: req.user.id,
          eventType: data.id ? 'kb.updated' : 'kb.created',
          payload: { kbId: kb.id, name: kb.name } });

    res.status(data.id ? 200 : 201).json(kb);
  } catch (err) { next(err); }
});

// ── POST /api/knowledge-bases/:id/sync — re-sincronizar ──────
router.post('/:id/sync', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
    });
    if (!kb) return res.status(404).json({ error: 'Base de conhecimento não encontrada.' });
    if (!kb.sourceUrl) return res.status(400).json({ error: 'Esta base não possui sourceUrl para sincronizar.' });

    let content = {};
    try {
      const resp = await fetch(kb.sourceUrl, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) return res.status(502).json({ error: `Falha ao buscar ${kb.sourceUrl}: HTTP ${resp.status}` });
      content = await resp.json().catch(() => ({}));
    } catch (fetchErr) {
      return res.status(502).json({ error: `Erro de rede ao sincronizar: ${fetchErr.message}` });
    }

    const updated = await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data:  { content, lastSyncedAt: new Date() },
    });

    log({ organizationId: req.organizationId, userId: req.user.id,
          eventType: 'kb.synced', payload: { kbId: kb.id, name: kb.name } });

    res.json(updated);
  } catch (err) { next(err); }
});

// ── DELETE /api/knowledge-bases/:id — desativar base ─────────
router.delete('/:id', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
    });
    if (!kb) return res.status(404).json({ error: 'Base de conhecimento não encontrada.' });

    await prisma.knowledgeBase.update({ where: { id: kb.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
