import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { isValidLatLon } from '../domain/geo.ts';
import { drawLogo } from '../services/acceptance-report.ts';
import { STICKERS, stickerOf, type Sticker } from '../services/coverage-operators.ts';
import { A4, PdfDoc, type Rgb } from '../services/pdf.ts';

/**
 * «Fattibilità» for sales (admins): can we serve an address, how well, and who else covers it with
 * which AGCOM sticker, in one answer and as a PDF for internal use. Our side is the same check as
 * Copertura (every AP in range rated by its estimated signal), the others the multi-operator one.
 */

type Verdict = 'yes' | 'maybe' | 'no';
const VERDICT: Record<Verdict, string> = { yes: 'Servizio CDA Net disponibile', maybe: 'Da verificare con un sopralluogo', no: 'Non coperto dalla rete CDA Net' };

interface OurAp {
  name: string;
  distanceM: number;
  bearing: number;
  rating: string;
  estimate: { signalDbm: number | null; capacityMbps?: number | null; eveningMbps?: number | null } | null;
  cpe?: { name: string } | null;
}

/** Our answer from the rated APs (pure): the best one decides. */
export function ourVerdict(aps: Array<Pick<OurAp, 'rating'>>): Verdict {
  if (aps.some((a) => a.rating === 'buono')) return 'yes';
  if (aps.some((a) => a.rating === 'possibile' || a.rating === 'senza stima')) return 'maybe';
  return 'no';
}

export function feasibilityRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireStaff, ctx.modules.require('coverage')] };
  const q = z.object({ lat: z.coerce.number(), lon: z.coerce.number(), label: z.string().trim().max(200).default('') });

  async function feasibility(req: FastifyRequest) {
    const p = q.parse(req.query);
    if (!isValidLatLon(p.lat, p.lon)) throw new HttpError(400, 'invalid_position');
    // our coverage: exactly what Copertura says for this point (same rules, same limits)
    const r = await app.inject({ method: 'GET', url: `/api/coverage?lat=${p.lat}&lon=${p.lon}&limit=3`, headers: { authorization: String(req.headers.authorization ?? '') } });
    if (r.statusCode !== 200) throw new HttpError(r.statusCode === 503 ? 503 : 502, (r.json() as { error?: string }).error ?? 'coverage_error');
    const cov = r.json() as { aps: OurAp[] };
    const aps = cov.aps.slice(0, 3);
    const verdict = ourVerdict(aps);
    const best = aps.find((a) => a.rating === 'buono') ?? aps[0] ?? null;
    const evening = best?.estimate?.eveningMbps ?? best?.estimate?.capacityMbps ?? null;
    const rules = { fwaMinMbps: ctx.cfg.coverageOps.fwaMinMbps, vhcnTechs: ctx.cfg.coverageOps.vhcnTechs.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean) };
    // our sticker with the same rules as the others' (a radio network, by its speed)
    const sticker: Sticker | null = verdict === 'no' || evening == null ? null : stickerOf({ technology: 'WIRELESS', family: 'FWA', maxMbps: evening, sourceSticker: '' }, rules).sticker;
    let operators: Awaited<ReturnType<AppContext['coverageOps']['atPoint']>> | null = null;
    let operatorsError: string | null = null;
    try {
      operators = await ctx.coverageOps.atPoint(p.lat, p.lon);
    } catch (e) {
      operatorsError = (e as HttpError).code ?? (e as Error).message;
    }
    const { fresh: _f, ...ops } = operators ?? ({ fresh: false } as never);
    return {
      at: new Date().toISOString(),
      point: { lat: p.lat, lon: p.lon, label: p.label },
      address: operators?.address?.label || p.label,
      ours: { verdict, title: VERDICT[verdict], eveningMbps: evening, sticker, stickerInfo: sticker ? STICKERS[sticker] : null, aps },
      operators: operators ? ops : null,
      operatorsError,
    };
  }

  app.get('/api/admin/feasibility', admin, async (req) => feasibility(req));

  app.get('/api/admin/feasibility.pdf', admin, async (req, reply) => {
    const f = await feasibility(req);
    recordEvent(ctx.db, req.user!.id, 'feasibility.pdf', f.operators?.address?.city || 'punto', f.ours.title);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="fattibilita-${new Date().toISOString().slice(0, 10)}.pdf"`);
    return reply.send(feasibilityPdf(f, feasibilityLogo(ctx.cfg.staticDir)));
  });
}

const logos = new Map<string, string | null>();
/** The CDA Net logo of the PDFs, read once (null when the web files are not there). */
export function feasibilityLogo(staticDir: string): string | null {
  if (!logos.has(staticDir)) {
    try {
      logos.set(staticDir, readFileSync(join(staticDir, 'assets', 'cda-net-logo.svg'), 'utf8'));
    } catch {
      logos.set(staticDir, null);
    }
  }
  return logos.get(staticDir) ?? null;
}

/** A filename made of the name of a saved check: letters, digits and dashes only. */
export const pdfFileName = (name: string, at: string) =>
  `fattibilita-${
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .toLowerCase() || 'punto'
  }-${at.slice(0, 10)}.pdf`;

const BRAND: Rgb = [241, 90, 44];
const BRAND_INK: Rgb = [194, 68, 26];
const MUTED: Rgb = [91, 98, 112];
const LINE: Rgb = [226, 229, 234];
const TONE: Record<Verdict, { fg: Rgb; bg: Rgb }> = { yes: { fg: [31, 122, 69], bg: [230, 244, 236] }, maybe: { fg: [138, 90, 0], bg: [255, 243, 214] }, no: { fg: [185, 28, 28], bg: [253, 232, 232] } };
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const M = 40;
const CW = A4.w - 2 * M;
const STATE: Record<string, string> = { available: 'attivabile', planned: 'in studio', none: 'non disponibile' };

/** The answer of a feasibility check, as the route gives it and as a saved check keeps it. */
export interface FeasibilityAnswer {
  at: string;
  point: { lat: number; lon: number };
  address: string;
  ours: { verdict: Verdict; title: string; eveningMbps: number | null; sticker: Sticker | null; aps: OurAp[] };
  operators: { groups: Array<{ sticker: Sticker; label: string; color: string; rows: Array<{ operator?: string; technologyLabel: string; state: string; maxMbps: number | null }> }> } | null;
  operatorsError: string | null;
}

/**
 * The PDF of a feasibility check. [who]: the name of a saved check (the customer of ISP Billing
 * with its code, or the name written), on top, above the address.
 */
export function feasibilityPdf(f: FeasibilityAnswer, logoSvg: string | null, who: { name: string; code?: string } | null = null): Buffer {
  const doc = new PdfDoc();
  let y = M;
  drawLogo(doc, logoSvg, M, y, 40);
  doc.text(A4.w - M, y + 2, 'Verifica di fattibilità', { size: 17, font: 'bold', align: 'right' });
  doc.text(A4.w - M, y + 24, `Uso interno · ${new Date(f.at).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' })}`, { size: 9.5, color: MUTED, align: 'right' });
  y += 52;
  doc.rect(M, y, CW, 2.5, BRAND);
  y += 16;
  if (who?.name) {
    doc.text(M, y, `${who.name}${who.code ? ` · cliente ${who.code}` : ''}`, { size: 13, font: 'bold' });
    y += 18;
    doc.text(M, y, f.address || `${f.point.lat.toFixed(5)}, ${f.point.lon.toFixed(5)}`, { size: 10.5 });
  } else doc.text(M, y, f.address || `${f.point.lat.toFixed(5)}, ${f.point.lon.toFixed(5)}`, { size: 12, font: 'bold' });
  y += 16;
  doc.text(M, y, `${f.point.lat.toFixed(5)}, ${f.point.lon.toFixed(5)}`, { size: 8.5, color: MUTED });
  y += 20;
  const t = TONE[f.ours.verdict];
  doc.rect(M, y, CW, 46, t.bg);
  doc.text(M + 12, y + 10, f.ours.title, { size: 13, font: 'bold', color: t.fg });
  doc.text(M + 12, y + 28, [f.ours.eveningMbps != null ? `capacità stimata la sera circa ${f.ours.eveningMbps} Mbit/s` : null, f.ours.sticker ? `bollino ${f.ours.sticker} (stima)` : null].filter(Boolean).join(' · ') || 'nessun AP utile entro il raggio', { size: 9, color: t.fg });
  y += 62;
  const section = (title: string) => {
    doc.text(M, y, title.toUpperCase(), { size: 8.5, font: 'bold', color: BRAND_INK });
    y += 13;
    doc.line(M, y, A4.w - M, y, LINE);
    y += 8;
  };
  section('Rete CDA Net: AP più adatti');
  if (!f.ours.aps.length) {
    doc.text(M, y, 'Nessun AP entro il raggio di copertura.', { size: 9.5, color: MUTED });
    y += 15;
  }
  for (const a of f.ours.aps) {
    doc.text(M, y, a.name, { size: 9.5, font: 'bold' });
    doc.text(M + 170, y, `${a.rating} · ${a.distanceM >= 1000 ? `${(a.distanceM / 1000).toFixed(1).replace('.', ',')} km` : `${a.distanceM} m`} · ${a.bearing}°${a.estimate?.signalDbm != null ? ` · ${a.estimate.signalDbm} dBm stimati` : ''}${a.cpe ? ` · ${a.cpe.name}` : ''}`, { size: 9 });
    y += 15;
  }
  y += 8;
  section('Altri operatori (bollino AGCOM)');
  if (!f.operators) {
    doc.text(M, y, f.operatorsError === 'operators_not_configured' ? 'Verifica degli altri operatori non configurata.' : 'Verifica degli altri operatori non riuscita.', { size: 9.5, color: MUTED });
    y += 15;
  } else {
    const shown = f.operators.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.state !== 'none') })).filter((g) => g.rows.length);
    if (!shown.length) {
      doc.text(M, y, 'Nessun altro operatore con offerte attivabili.', { size: 9.5, color: MUTED });
      y += 15;
    }
    for (const g of shown) {
      if (y > A4.h - 90) {
        doc.addPage();
        y = M;
      }
      doc.rect(M, y - 2, 30, 14, hex(g.color));
      doc.text(M + 15, y, g.sticker, { size: 8.5, font: 'bold', color: g.sticker === 'FR' ? [31, 35, 40] : [255, 255, 255], align: 'center' });
      doc.text(M + 38, y, g.label, { size: 9.5, font: 'bold' });
      y += 17;
      for (const r of g.rows) {
        doc.text(M + 38, y, `${r.operator ?? ''} ${r.technologyLabel}`.trim(), { size: 9 });
        doc.text(M + 260, y, `${STATE[r.state] ?? r.state}${r.maxMbps ? ` · fino a ${r.maxMbps >= 1000 ? `${r.maxMbps / 1000} Gbit/s` : `${Math.round(r.maxMbps)} Mbit/s`}` : ''}`, { size: 9, color: MUTED });
        y += 14;
      }
      y += 4;
    }
  }
  doc.line(M, A4.h - 38, A4.w - M, A4.h - 38, LINE);
  doc.text(M, A4.h - 32, 'CDA Net · AS200034 · Stime del modello di copertura e dati degli operatori: la verifica sul posto resta necessaria.', { size: 7.5, color: MUTED });
  return doc.build();
}
