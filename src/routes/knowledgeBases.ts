import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { log } from '../utils/audit';
import logger from '../utils/logger';
import { generateEmbedding } from '../services/openai';

const router = Router();

// ── Auxiliar: Gerar embedding p/ conteúdo JSON ───────────────
async function processEmbedding(content: unknown): Promise<number[] | null> {
  try {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const result = await generateEmbedding(text);
    return result.embedding;
  } catch (err) {
    logger.error({ event: 'kb.embedding_failed', err: (err as Error).message });
    return null;
  }
}

// ── GET /api/knowledge-bases ─────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const kbs = await prisma.knowledgeBase.findMany({
      where:   { organizationId: req.organizationId!, isActive: true },
      select:  { id: true, name: true, sourceUrl: true, lastSyncedAt: true, updatedAt: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    res.json({ knowledgeBases: kbs });
  } catch (err) { next(err); }
});

// ── POST /api/knowledge-bases — criar ou atualizar base ──────
router.post('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = z.object({
      id:        z.string().optional(),
      name:      z.string().min(2),
      sourceUrl: z.string().url().optional().nullable(),
      content:   z.record(z.unknown()).optional(),
    }).parse(req.body);

    let content: Record<string, unknown> = data.content || {};

    if (data.sourceUrl && !data.content) {
      try {
        const resp = await fetch(data.sourceUrl, { signal: AbortSignal.timeout(10_000) });
        if (resp.ok) content = await resp.json().catch(() => ({})) as Record<string, unknown>;
        else logger.warn({ event: 'kb.fetch_failed', sourceUrl: data.sourceUrl, status: resp.status });
      } catch (fetchErr) {
        logger.warn({ event: 'kb.fetch_error', sourceUrl: data.sourceUrl, err: (fetchErr as Error).message });
      }
    }

    let kb;
    if (data.id) {
      const existing = await prisma.knowledgeBase.findFirst({
        where: { id: data.id, organizationId: req.organizationId! },
      });
      if (!existing) { res.status(404).json({ error: 'Base de conhecimento não encontrada.' }); return; }

      kb = await prisma.knowledgeBase.update({
        where: { id: data.id },
        data:  { name: data.name, sourceUrl: data.sourceUrl, content: content as Prisma.InputJsonValue, lastSyncedAt: new Date() },
      });
    } else {
      kb = await prisma.knowledgeBase.create({
        data: {
          organizationId: req.organizationId!,
          name:           data.name,
          sourceUrl:      data.sourceUrl,
          content:        content as Prisma.InputJsonValue,
          lastSyncedAt:   new Date(),
        },
      });
    }

    if (content) {
      const vector = await processEmbedding(content);
      if (vector) {
        await prisma.$executeRawUnsafe(
          `UPDATE knowledge_bases SET embedding = '[${vector.join(',')}]'::vector WHERE id = $1`,
          kb.id
        ).catch((e: Error) => logger.error({ event: 'kb.vector_save_error', err: e.message }));
      }
    }

    log({ organizationId: req.organizationId!, userId: req.user!.id,
          eventType: data.id ? 'kb.updated' : 'kb.created',
          payload: { kbId: kb.id, name: kb.name } });

    res.status(data.id ? 200 : 201).json(kb);
  } catch (err) { next(err); }
});

// ── POST /api/knowledge-bases/:id/sync — re-sincronizar ──────
router.post('/:id/sync', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
    });
    if (!kb) { res.status(404).json({ error: 'Base de conhecimento não encontrada.' }); return; }
    if (!kb.sourceUrl) { res.status(400).json({ error: 'Esta base não possui sourceUrl para sincronizar.' }); return; }

    let content: Record<string, unknown> = {};
    try {
      const resp = await fetch(kb.sourceUrl, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) { res.status(502).json({ error: `Falha ao buscar ${kb.sourceUrl}: HTTP ${resp.status}` }); return; }
      content = await resp.json().catch(() => ({})) as Record<string, unknown>;
    } catch (fetchErr) {
      res.status(502).json({ error: `Erro de rede ao sincronizar: ${(fetchErr as Error).message}` });
      return;
    }

    const updated = await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data:  { content: content as Prisma.InputJsonValue, lastSyncedAt: new Date() },
    });

    log({ organizationId: req.organizationId!, userId: req.user!.id,
          eventType: 'kb.synced', payload: { kbId: kb.id, name: kb.name } });

    res.json(updated);
  } catch (err) { next(err); }
});

// ── DELETE /api/knowledge-bases/:id — desativar base ─────────
router.delete('/:id', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
    });
    if (!kb) { res.status(404).json({ error: 'Base de conhecimento não encontrada.' }); return; }

    await prisma.knowledgeBase.update({ where: { id: kb.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
