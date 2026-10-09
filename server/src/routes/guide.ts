import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

const DIR = fileURLToPath(new URL('../guide-admin/', import.meta.url));

/**
 * Administrator guide: kept out of the public web directory and served only to admins, page and
 * images alike (the installer guide is the static /wiki/ page).
 */
export function guideRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin] };

  app.get('/api/admin/guide', admin, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { html: await readFile(join(DIR, 'index.html'), 'utf8') };
  });

  app.get('/api/admin/guide/img/:name', admin, async (req, reply) => {
    const { name } = z.object({ name: z.string().regex(/^[a-z0-9-]+\.jpg$/) }).parse(req.params);
    const data = await readFile(join(DIR, 'img', name)).catch(() => null);
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return reply.header('Cache-Control', 'private, no-store').type('image/jpeg').send(data);
  });
}
