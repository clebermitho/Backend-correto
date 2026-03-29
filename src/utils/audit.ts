import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import type { Request } from 'express';

interface AuditParams {
  organizationId: string;
  userId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
  req?: Request | null;
}

export async function log({ organizationId, userId = null, eventType, payload = {}, req = null }: AuditParams): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: {
        organizationId,
        userId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        ipAddress: req ? (req.ip || (req.headers['x-forwarded-for'] as string)) : null,
        userAgent: req ? (req.headers['user-agent'] as string) : null,
      },
    });
  } catch (err) {
    console.error('[Audit] Falha ao registrar evento:', err instanceof Error ? err.message : err);
  }
}
