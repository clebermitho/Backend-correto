/**
 * /api/v1 — versioned API index router.
 *
 * All routes under /api/v1/* use the standard response envelope:
 *   Success: { success: true, data: {...}, traceId?: string }
 *   Error:   { success: false, error: { code, message, details?, traceId? } }
 *
 * Existing /api/* routes remain unchanged for backward compat.
 */

import { Router } from 'express';
import aiV1Router from './ai';

const v1Router = Router();

v1Router.use('/ai', aiV1Router);

export default v1Router;
