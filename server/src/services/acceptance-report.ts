import { A4, PdfDoc, wrap, type Rgb } from './pdf.ts';

/**
 * «Rapporto di collaudo» of an installation as a PDF, laid out like an intervention report: CDA Net
 * logo, outcome, customer and CPE, radio link, network, the app's checks, notes, the NOC's
 * decision and the installer's photos. For the NOC, and for the installer of the job (without the
 * name of the data source); never the PPPoE password.
 */

export interface ReportData {
  job: {
    id: string;
    customer: string;
    pppoeUser: string;
    address: string;
    model: string;
    mac: string;
    serial: string;
    ssid: string;
    template: string;
    installer: string;
    installedAt: string | null;
    latitude: number | null;
    longitude: number | null;
    uispSite: string | null;
  };
  acceptance: {
    createdAt: string;
    by: string;
    verdict: 'ok' | 'warn' | 'bad';
    data: Record<string, unknown>;
    review: { state: string; reason: string; at: string | null; by: string | null; note: string } | null;
  };
  photos: Array<{ caption: string; createdAt: string; data: Buffer | null }>;
  /** The required photos the test lacks (labels), shown to the NOC and in the report. */
  photosMissing?: string[];
  /** SVG of the CDA Net logo (circles, lines, lettering paths); null = the name in text. */
  logoSvg: string | null;
  generatedAt: Date;
  /** For an installer: no name of the data source (the site of UISP becomes «in rete»). */
  forInstaller?: boolean;
}

const BRAND: Rgb = [241, 90, 44];
const BRAND_INK: Rgb = [194, 68, 26];
const INK: Rgb = [20, 23, 28];
const MUTED: Rgb = [91, 98, 112];
const LINE: Rgb = [226, 229, 234];
const SOFT: Rgb = [247, 248, 250];
const TONES: Record<string, { fg: Rgb; bg: Rgb }> = {
  ok: { fg: [31, 122, 69], bg: [230, 244, 236] },
  warn: { fg: [138, 90, 0], bg: [255, 243, 214] },
  bad: { fg: [185, 28, 28], bg: [253, 232, 232] },
  info: { fg: [29, 78, 216], bg: [232, 240, 254] },
};

const M = 40; // page margin
const CW = A4.w - 2 * M; // content width
const BOTTOM = A4.h - 50;

const rome = (iso: string | null | undefined, withTime = true) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
};
const num = (v: unknown, unit: string, digits = 0) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toLocaleString('it-IT', { maximumFractionDigits: digits })} ${unit}`.trim() : '—');
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '—');
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** The CDA Net logo from its SVG (viewBox 0 0 2000 712), [h] points tall. */
function drawLogo(doc: PdfDoc, svg: string | null, x: number, top: number, h: number) {
  if (!svg) {
    doc.text(x, top + h / 4, 'CDA Net', { size: h / 2, font: 'bold', color: BRAND });
    return;
  }
  const s = h / 712;
  for (const m of svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"[^>]*stroke-width="([\d.]+)"/g)) {
    doc.circle(x + Number(m[1]) * s, top + Number(m[2]) * s, Number(m[3]) * s, { stroke: BRAND, width: Number(m[4]) * s });
  }
  for (const m of svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*stroke-width="([\d.]+)"/g)) {
    doc.line(x + Number(m[1]) * s, top + Number(m[2]) * s, x + Number(m[3]) * s, top + Number(m[4]) * s, BRAND, Number(m[5]) * s);
  }
  for (const m of svg.matchAll(/<path d="([^"]+)"/g)) doc.svgPath(m[1]!, x, top, s, BRAND);
}

export function acceptanceReportPdf(r: ReportData): Buffer {
  const doc = new PdfDoc();
  const a = r.acceptance.data;
  const cpe = obj(a.cpe);
  const radio = obj(a.radio);
  const lan = obj(a.lan);
  const pppoe = obj(a.pppoe);
  const internet = obj(a.internet);
  let y = M;

  const footer = () => {
    doc.line(M, A4.h - 38, A4.w - M, A4.h - 38, LINE);
    doc.text(M, A4.h - 32, `CDA Net · AS200034 · Rapporto di collaudo · installazione ${r.job.id.slice(0, 8)}`, { size: 7.5, color: MUTED });
    doc.text(A4.w - M, A4.h - 32, `Generato il ${rome(r.generatedAt.toISOString())}`, { size: 7.5, color: MUTED, align: 'right' });
  };
  const newPage = () => {
    footer();
    doc.addPage();
    y = M;
  };
  const need = (h: number) => {
    if (y + h > BOTTOM) newPage();
  };
  const section = (title: string) => {
    need(40);
    y += 8;
    doc.text(M, y, title.toUpperCase(), { size: 8.5, font: 'bold', color: BRAND_INK });
    y += 13;
    doc.line(M, y, A4.w - M, y, LINE);
    y += 7;
  };
  /** Label/value pairs in two columns. */
  const grid = (rows: Array<[string, string]>) => {
    const colW = CW / 2;
    for (let i = 0; i < rows.length; i += 2) {
      const pair = rows.slice(i, i + 2);
      const heights = pair.map(([, v]) => wrap(v, 9.5, colW - 112).length * 12.5);
      const h = Math.max(...heights, 12.5) + 4;
      need(h);
      pair.forEach(([label, value], j) => {
        const x = M + j * colW;
        doc.text(x, y, label, { size: 8.5, color: MUTED });
        doc.paragraph(x + 104, y - 0.5, colW - 112, value, { size: 9.5, leading: 12.5 });
      });
      y += h;
    }
  };

  // ---- header: logo, title, outcome --------------------------------------------------------
  drawLogo(doc, r.logoSvg, M, y, 40);
  doc.text(A4.w - M, y + 2, 'Rapporto di collaudo', { size: 17, font: 'bold', align: 'right' });
  doc.text(A4.w - M, y + 24, `Installazione CPE · ${rome(r.acceptance.createdAt)}`, { size: 9.5, color: MUTED, align: 'right' });
  y += 52;
  doc.rect(M, y, CW, 2.5, BRAND);
  y += 14;

  // marked as passed by the NOC whatever the measures said: said in the outcome
  const override = a.override as { from?: string; by?: string; at?: string; note?: string } | undefined;
  const verdictLabel = override ? 'SUPERATO PER DECISIONE DEL NOC' : { ok: 'COLLAUDO SUPERATO', warn: 'SUPERATO CON AVVISI', bad: 'COLLAUDO NON SUPERATO' }[r.acceptance.verdict];
  const tone = TONES[r.acceptance.verdict]!;
  const review = r.acceptance.review;
  const reviewText = override
    ? `Deciso dal NOC (${override.by ?? '—'}) il ${rome(override.at ?? null)}`
    : !review
    ? 'Nessuna approvazione del NOC richiesta'
    : review.state === 'approved'
      ? `Approvato dal NOC${review.by ? ` (${review.by})` : ''} il ${rome(review.at)}`
      : review.state === 'rejected'
        ? `Rifiutato dal NOC${review.by ? ` (${review.by})` : ''} il ${rome(review.at)}`
        : 'In attesa di approvazione del NOC';
  doc.rect(M, y, CW, 44, tone.bg);
  doc.rect(M, y, 5, 44, tone.fg);
  doc.text(M + 16, y + 9, verdictLabel, { size: 13, font: 'bold', color: tone.fg });
  doc.text(M + 16, y + 27, `Collaudo di ${r.acceptance.by} · ${num(a.samples, 'misure')}`, { size: 9, color: INK });
  doc.text(A4.w - M - 12, y + 10, reviewText, { size: 9, font: 'bold', color: review?.state === 'rejected' ? TONES.bad!.fg : INK, align: 'right' });
  if (radio.signal != null) doc.text(A4.w - M - 12, y + 27, `Segnale ${num(radio.signal, 'dBm')} · CINR ${num(radio.cinrRx, 'dB')}`, { size: 9, color: MUTED, align: 'right' });
  y += 58;

  // ---- customer and installation -------------------------------------------------------------
  section('Cliente e installazione');
  grid([
    ['Cliente', r.job.customer || '—'],
    ['Utente PPPoE', r.job.pppoeUser || '—'],
    ['Indirizzo', r.job.address || '—'],
    ['Posizione', r.job.latitude != null && r.job.longitude != null ? `${r.job.latitude.toFixed(5)}, ${r.job.longitude.toFixed(5)}` : '—'],
    ['Installatore', r.job.installer || '—'],
    ['Installata il', rome(r.job.installedAt)],
    r.forInstaller ? ['In rete', r.job.uispSite ? 'attiva' : 'in attesa di attivazione'] : ['Sito UISP', r.job.uispSite || 'non ancora accettata'],
    ['Altezza CPE', num(a.cpeHeightM, 'm dal suolo', 1)],
  ]);

  section('CPE');
  grid([
    ['Modello', str(cpe.model) !== '—' ? str(cpe.model) : r.job.model],
    ['Nome', str(cpe.hostname)],
    ['MAC', r.job.mac || '—'],
    ['Seriale', r.job.serial || '—'],
    ['Firmware', str(cpe.firmware)],
    ['Template', r.job.template || '—'],
  ]);

  section('Collegamento radio');
  const chains = Array.isArray(radio.chains) && radio.chains.length ? (radio.chains as number[]).map((c) => `${c}`).join(' / ') + ' dBm' : '—';
  grid([
    ['AP', `${str(cpe.apName)}${cpe.essid ? ` · ${String(cpe.essid)}` : ''}`],
    ['Distanza', num(cpe.distanceM, 'm')],
    ['Frequenza', `${num(cpe.frequencyMhz, 'MHz')}${cpe.channelWidthMhz ? ` · ${num(cpe.channelWidthMhz, 'MHz')} di canale` : ''}`],
    ['Segnale', `${num(radio.signal, 'dBm')}${radio.signalMin != null ? ` (min ${num(radio.signalMin, '')} · max ${num(radio.signalMax, '')})` : ''}`],
    ['Segnale atteso', num(radio.expectedSignal, 'dBm')],
    ['Catene', chains],
    ['Segnale lato AP', num(radio.remoteSignal, 'dBm')],
    ['Rumore', num(radio.noise, 'dBm')],
    ['CINR rx / tx', `${num(radio.cinrRx, 'dB')} / ${num(radio.cinrTx, 'dB')}`],
    ['Capacità', `${num(radio.dlCapacityMbps, 'Mbps')} giù · ${num(radio.ulCapacityMbps, 'Mbps')} su`],
  ]);

  section('Rete del cliente e Internet');
  grid([
    ['Cavo LAN', lan.plugged === false ? 'non collegato' : `${num(lan.speedMbps, 'Mbps')}${lan.fullDuplex === true ? ' full duplex' : lan.fullDuplex === false ? ' half duplex' : ''}${lan.cableLenM != null ? ` · circa ${num(lan.cableLenM, 'm')}` : ''}`],
    ['PPPoE', pppoe.enabled === false ? 'non attivo' : str(pppoe.ip) !== '—' ? `connesso · IP ${str(pppoe.ip)}` : '—'],
    ['Ping / jitter', internet.tested ? `${num(internet.pingMs, 'ms')} / ${num(internet.jitterMs, 'ms')}` : 'non provato'],
    ['Velocità', internet.tested ? `${num(internet.downloadMbps, 'Mbps', 1)} giù · ${num(internet.uploadMbps, 'Mbps', 1)} su` : 'non provata'],
  ]);
  if (typeof internet.note === 'string' && internet.note.trim()) {
    need(16);
    y += doc.paragraph(M, y, CW, `Nota: ${internet.note.trim()}`, { size: 8.5, color: MUTED }) + 2;
  }

  // ---- speedtest and the Wi-Fi of the customer's router -------------------------------------
  const st = obj(a.speedtest);
  if (Object.keys(st).length) {
    const tg = obj(st.target);
    section('Speedtest');
    grid([
      ['Velocità misurata', `${num(st.downMbps, 'Mbps', 1)} giù · ${num(st.upMbps, 'Mbps', 1)} su`],
      ['Ping / jitter', `${num(st.pingMs, 'ms')} / ${num(st.jitterMs, 'ms')}`],
      ['Profilo del cliente', Object.keys(tg).length ? `${str(tg.profile)} · ${num(tg.downMbps, 'Mbps')} giù · ${num(tg.upMbps, 'Mbps')} su` : 'non noto'],
      ['Esito', st.passed === true ? `superato (almeno ${num(tg.minPct, '%')} del profilo)` : st.passed === false ? `sotto il ${num(tg.minPct, '%')} del profilo` : 'senza confronto'],
      ['Tentativi', num(st.attempts, '')],
      ['Server', str(st.server)],
    ]);
  }
  const wf = obj(a.wifi);
  if (Object.keys(wf).length) {
    section('Wi-Fi del router del cliente');
    grid([
      ['Rete', str(wf.ssid)],
      ['Banda / canale', `${wf.band ? `${String(wf.band)} GHz` : '—'} · canale ${num(wf.channel, '')}${wf.widthMhz != null ? ` · ${num(wf.widthMhz, 'MHz')}` : ''}`],
      ['Segnale del telefono', `${num(wf.rssi, 'dBm')}${wf.linkMbps != null ? ` · collegamento ${num(wf.linkMbps, 'Mbps')}` : ''}`],
      ['Reti vicine', `${num(wf.neighborsSameChannel, 'sullo stesso canale')} · ${num(wf.neighborsOverlapping, 'sovrapposte')}${wf.congested === true ? ' · canale affollato' : ''}`],
      ['Canale consigliato', wf.suggestedChannel != null ? num(wf.suggestedChannel, '') : '—'],
      ['Modifiche fatte', str(wf.changed)],
    ]);
  }

  // ---- the app's checks ---------------------------------------------------------------------
  const checks = Array.isArray(a.checks) ? (a.checks as Array<{ title: string; verdict: string; detail: string }>) : [];
  if (checks.length) {
    section('Verifiche');
    const label: Record<string, string> = { ok: 'OK', warn: 'ATTENZIONE', bad: 'NO', info: 'INFO' };
    for (const c of checks) {
      const lines = wrap(c.detail || '', 9, CW - 210);
      const h = Math.max(lines.length * 12, 12) + 7;
      need(h);
      const t = TONES[c.verdict] ?? TONES.info!;
      doc.rect(M, y - 2, 64, 13, t.bg);
      doc.text(M + 32, y + 0.5, label[c.verdict] ?? c.verdict, { size: 7, font: 'bold', color: t.fg, align: 'center' });
      doc.text(M + 74, y, c.title, { size: 9, font: 'bold' });
      doc.paragraph(M + 210, y, CW - 210, c.detail || '', { size: 9, color: MUTED, leading: 12 });
      y += h;
    }
  }

  // ---- notes and NOC ------------------------------------------------------------------------
  if (typeof a.notes === 'string' && a.notes.trim()) {
    section("Note dell'installatore");
    need(30);
    y += doc.paragraph(M, y, CW, a.notes.trim(), { size: 9.5 }) + 4;
  }
  if (review) {
    section('Approvazione del NOC');
    grid([
      ['Stato', override ? `segnato come superato (le misure dicevano: ${override.from === 'bad' ? 'non superato' : 'con riserva'})` : review.state === 'approved' ? 'approvato' : review.state === 'rejected' ? 'rifiutato' : 'in attesa'],
      ['Motivo della verifica', override ? 'decisione del NOC' : review.reason || '—'],
      ['Deciso da', review.by ?? '—'],
      ['Data della decisione', rome(review.at)],
    ]);
    if (review.note) grid([['Nota del NOC', review.note]]);
  }

  if (r.photosMissing?.length) grid([['Foto obbligatorie mancanti', r.photosMissing.join(', ')]]);

  // ---- photos, two per row ----------------------------------------------------------------------
  const photos = r.photos.filter((p) => p.data);
  if (photos.length) {
    newPage();
    doc.text(M, y, 'Foto dell\'installazione', { size: 13, font: 'bold' });
    doc.text(A4.w - M, y + 2, `${photos.length} ${photos.length === 1 ? 'foto' : 'foto'} inviate dall'installatore`, { size: 9, color: MUTED, align: 'right' });
    y += 22;
    const gap = 14;
    const pw = (CW - gap) / 2;
    const ph = 230;
    photos.forEach((p, i) => {
      const col = i % 2;
      if (col === 0) need(ph + 30);
      const x = M + col * (pw + gap);
      doc.rect(x, y, pw, ph, SOFT, LINE, 0.5);
      if (!doc.jpeg(p.data!, x + 4, y + 4, pw - 8, ph - 8)) doc.text(x + pw / 2, y + ph / 2 - 5, 'foto non leggibile', { size: 9, color: MUTED, align: 'center' });
      doc.text(x, y + ph + 5, p.caption || `Foto ${i + 1}`, { size: 9, font: 'bold' });
      doc.text(x + pw, y + ph + 5, rome(p.createdAt), { size: 8, color: MUTED, align: 'right' });
      if (col === 1 || i === photos.length - 1) y += ph + 26;
    });
  }
  // ---- signature and NOC's mark, at the end of the report -------------------------------------------------------
  need(70);
  y += 18;
  const sw = (CW - 30) / 2;
  // the installer and the NOC (no customer signature: the owner's choice in the plan of October)
  for (const [i, who] of [`Firma installatore (${r.acceptance.by})`, 'Visto del NOC'].entries()) {
    const x = M + i * (sw + 30);
    doc.line(x, y + 36, x + sw, y + 36, MUTED, 0.6);
    doc.text(x, y + 41, who, { size: 8, color: MUTED });
  }
  footer();
  return doc.build();
}
