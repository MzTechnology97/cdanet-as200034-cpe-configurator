import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { LiveTopic } from '../services/live.ts';
import { seesAll } from '../auth.ts';

/** A stream lasts at most this long: the console opens a new one, checked again like any request. */
const MAX_STREAM_MS = 15 * 60_000;
/** A comment every so often keeps proxies and phones from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Live updates of the console: Server-Sent Events, one event per change ("notifications",
 * "advisor", "outages"), no data in them (the page asks the API again with its rights).
 * The console reads it with fetch and its usual Authorization header, not with EventSource (which
 * would put the token in the address).
 */
export function liveRoutes(app: FastifyInstance, ctx: AppContext) {
  // the console's session, or the read-only token of the app's background service (notifications
  // on the phone without Firebase): same stream, same format
  const streamUser = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await ctx.auth.requireUser(req, reply);
    } catch (e) {
      const feed = await ctx.auth.verifyFeedToken(req, ['feed']).catch(() => null);
      if (!feed) throw e;
      req.user = feed;
    }
  };
  app.get('/api/events', { preHandler: streamUser }, async (req, reply) => {
    const u = req.user!;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx and similar proxies: deliver each event at once
      'X-Accel-Buffering': 'no',
    });
    const write = (s: string) => {
      if (!res.writableEnded) res.write(s);
    };
    write(`retry: 5000\nevent: ready\ndata: {}\n\n`);
    const unsubscribe = ctx.live.subscribe({ userId: u.id, admin: seesAll(u), send: (topic: LiveTopic) => write(`event: ${topic}\ndata: {}\n\n`) });
    const beat = setInterval(() => write(`: ${Date.now()}\n\n`), HEARTBEAT_MS);
    const end = setTimeout(() => res.end(), MAX_STREAM_MS);
    const close = () => {
      clearInterval(beat);
      clearTimeout(end);
      unsubscribe();
    };
    req.raw.on('close', close);
    res.on('close', close);
  });
}
