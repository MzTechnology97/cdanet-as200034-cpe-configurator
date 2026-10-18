import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { servedArc } from '../domain/coverage-model.ts';
import { bearingDeg, distanceM } from '../domain/geo.ts';
import { antennaIdOf } from '../services/model-inputs.ts';
import { isPtp } from '../services/uisp.ts';

/** A Rocket (or any radio without its own antenna): UISP cannot know what is mounted on it. */
export const needsExternalAntenna = (model: string | null) => /rocket|^R5AC|^RP-5AC|^RM5|^R5-|^R2/i.test(model ?? '');

/** The azimuth the customers suggest: the middle of the arc they are in (≥ 3 customers). */
export function suggestedAzimuth(ap: { lat: number; lon: number }, clients: Array<{ lat: number; lon: number }>): { azimuth: number; arc: number } | null {
  const b = clients.filter((c) => distanceM(ap, c) >= 50).map((c) => bearingDeg(ap, c));
  if (b.length < 3) return null;
  const arc = servedArc(b);
  return arc ? { azimuth: Math.round(arc.center), arc: Math.round(arc.width) } : null;
}

/**
 * Antenne degli AP (admins): the library of the makers' patterns (downloaded on request), and for
 * every AP its antenna, azimuth and tilt, with the azimuth the customers suggest.
 */
export function antennaRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin] };
  // the makers' patterns: a technical tool for every specialist
  const staff = { preHandler: [ctx.auth.requireStaff] };
  // CDA Net's APs (names, customers, azimuths) and loading the library they use: only with
  // «visibilità piena» (issue #275); assigning an antenna to an AP stays with the admins
  const all = { preHandler: [ctx.auth.requireSeesAll] };

  app.get('/api/admin/antennas', all, async () => {
    const lib = ctx.antennas.library().map(({ az: _a, el: _e, ...p }) => p);
    const assigned = ctx.antennas.assigned();
    const aps = ctx.uisp
      ? (await ctx.uisp.modelInputs())
          .aps.filter((a) => !isPtp(a.device))
          .map((a) => {
            const own = antennaIdOf(ctx, a.device);
            return {
              id: a.device.id,
              name: a.device.name,
              model: a.device.model,
              customers: a.clients.length,
              uispAzimuth: a.device.heading,
              suggested: suggestedAzimuth(a.location, a.clients),
              external: needsExternalAntenna(a.device.model),
              antennaId: own.id,
              antennaFrom: own.from,
              azimuth: assigned[a.device.id]?.azimuth ?? null,
              tilt: assigned[a.device.id]?.tilt ?? null,
            };
          })
          .sort((x, y) => x.name.localeCompare(y.name))
      : [];
    return { library: lib, import: ctx.antennas.state(), aps };
  });

  /** One pattern with its two cuts (the console draws it). */
  app.get('/api/admin/antennas/pattern/:id', staff, async (req) => {
    const p = ctx.antennas.pattern(z.object({ id: z.string().max(80) }).parse(req.params).id);
    if (!p) throw new HttpError(404, 'not_found');
    return p;
  });

  /** Downloads the patterns of Ubiquiti and RF elements (about 1 MB) and rebuilds the library. */
  app.post('/api/admin/antennas/import', all, async (req) => {
    if (ctx.antennas.state().running) throw new HttpError(409, 'import_running');
    recordEvent(ctx.db, req.user!.id, 'antennas.import', 'Diagrammi delle antenne', 'Ubiquiti airMAX e RF elements');
    void ctx.antennas.importLibrary();
    return { started: true };
  });

  app.put('/api/admin/antennas/ap/:id', admin, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(req.params);
    const b = z
      .object({
        antennaId: z.string().max(80).nullable(),
        azimuth: z.number().min(0).max(360).nullable(),
        tilt: z.number().min(-30).max(30).nullable(),
      })
      .parse(req.body);
    if (b.antennaId && !ctx.antennas.pattern(b.antennaId)) throw new HttpError(400, 'unknown_antenna');
    ctx.antennas.set(id, { antennaId: b.antennaId, azimuth: b.azimuth === null ? null : b.azimuth % 360, tilt: b.tilt }, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'antennas.ap', id, `${b.antennaId ?? 'antenna non indicata'} · azimut ${b.azimuth ?? '—'} · tilt ${b.tilt ?? '—'}`);
    return { ok: true };
  });
}
