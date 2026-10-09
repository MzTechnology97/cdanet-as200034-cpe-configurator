import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { KO_REASONS } from './ko.ts';

/** Installation statistics for the management: per month and per installer. */
export function statsRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('stats')] };

  app.get('/api/admin/stats', admin, async (req) => {
    const { months } = z.object({ months: z.coerce.number().int().min(1).max(36).default(6) }).parse(req.query);
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1)).toISOString();
    const base = `FROM provisioning_jobs j LEFT JOIN job_acceptance a ON a.job_id = j.id WHERE j.created_at >= ? AND j.status IN ('success','failed')`;
    const cols = `count(*) jobs,
         SUM(j.status = 'success') success,
         SUM(j.status = 'failed') failed,
         SUM(a.job_id IS NOT NULL) acceptances,
         SUM(a.verdict = 'ok') acceptOk,
         SUM(a.verdict = 'warn') acceptWarn,
         SUM(a.verdict = 'bad') acceptBad,
         ROUND(AVG(json_extract(a.data, '$.radio.signal')), 1) avgSignal,
         ROUND(AVG(json_extract(a.data, '$.internet.downloadMbps')), 1) avgDownload,
         SUM(j.replaces_job_id IS NOT NULL) replacements,
         SUM(j.uisp_authorized_at IS NOT NULL) uispAccepted`;
    const byMonth = ctx.db.prepare(`SELECT substr(j.created_at, 1, 7) month, ${cols} ${base} GROUP BY month ORDER BY month`).all(from);
    const byInstaller = ctx.db
      .prepare(`SELECT u.username installer, ${cols}, MAX(j.created_at) lastJob ${base.replace('LEFT JOIN job_acceptance', 'JOIN users u ON u.id = j.user_id LEFT JOIN job_acceptance')} GROUP BY u.id ORDER BY jobs DESC`)
      .all(from);
    const byModel = ctx.db.prepare(`SELECT j.model, count(*) jobs, SUM(j.status = 'failed') failed ${base.replace(' LEFT JOIN job_acceptance a ON a.job_id = j.id', '')} GROUP BY j.model ORDER BY jobs DESC`).all(from);
    // Fill empty months so the chart has no gaps.
    const map = new Map((byMonth as Array<{ month: string }>).map((m) => [m.month, m]));
    const monthsList = Array.from({ length: months }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1) + i, 1));
      const key = d.toISOString().slice(0, 7);
      return map.get(key) ?? { month: key, jobs: 0, success: 0, failed: 0, acceptances: 0, acceptOk: 0, acceptWarn: 0, acceptBad: 0, avgSignal: null, avgDownload: null, replacements: 0, uispAccepted: 0 };
    });
    // postponed / KO reports by month and reason (attempts, not installations: retries are allowed)
    const ko = ctx.db
      .prepare(`SELECT substr(created_at, 1, 7) month, kind, reason, count(*) n, SUM(resolved_at IS NOT NULL) resolved FROM install_ko WHERE created_at >= ? GROUP BY month, kind, reason`)
      .all(from) as Array<{ month: string; kind: string; reason: string; n: number; resolved: number }>;
    for (const m of monthsList as Array<Record<string, unknown>>) {
      m.postponed = ko.filter((k) => k.month === m.month && k.kind === 'postponed').reduce((a, k) => a + k.n, 0);
      m.definitive = ko.filter((k) => k.month === m.month && k.kind === 'definitive').reduce((a, k) => a + k.n, 0);
    }
    const reasons = new Map<string, { reason: string; label: string; postponed: number; definitive: number; resolved: number }>();
    for (const k of ko) {
      const r = reasons.get(k.reason) ?? { reason: k.reason, label: KO_REASONS[k.reason as keyof typeof KO_REASONS] ?? k.reason, postponed: 0, definitive: 0, resolved: 0 };
      if (k.kind === 'postponed') r.postponed += k.n;
      else r.definitive += k.n;
      r.resolved += k.resolved;
      reasons.set(k.reason, r);
    }
    const koReasons = [...reasons.values()].sort((a, b) => b.postponed + b.definitive - (a.postponed + a.definitive));
    return { from, months: monthsList, installers: byInstaller, models: byModel, koReasons };
  });
}
