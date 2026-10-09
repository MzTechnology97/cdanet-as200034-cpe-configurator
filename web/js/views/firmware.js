import { api } from '../api.js';
import { badge, busy, card, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

const mb = (n) => `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/**
 * "Firmware airOS": the reference images the app keeps on the phone to bring a CPE to the
 * version required by the provisioning. Platform and version come from the file itself.
 */
export async function firmwareView() {
  const box = h('div', {});
  const file = h('input', { type: 'file', accept: '.bin,application/octet-stream' });
  const upload = h('button', { class: 'primary' }, 'Carica firmware');

  async function load() {
    const d = await api('/api/admin/firmware');
    const platforms = [...new Set(d.items.filter((i) => i.target).map((i) => i.platform))];
    mount(
      box,
      card(
        h('h3', {}, 'Carica un firmware'),
        h(
          'p',
          { class: 'small muted' },
          `Versione richiesta dal provisioning: ${d.target}. Carica il file .bin ufficiale airOS di ogni piattaforma usata dalle CPE (es. XC, WA, 2XC): la piattaforma e la versione si leggono dal file. ` +
            'Nell’app compaiono solo i firmware della versione richiesta; l’installatore li scarica con Internet e li installa sulla CPE dalla sua Wi-Fi di management.',
        ),
        h('div', { class: 'row' }, file, upload),
        platforms.length
          ? h('p', { class: 'small' }, `Piattaforme pronte per ${d.target}: `, ...platforms.map((p) => badge(p, 'good')))
          : h('p', { class: 'small' }, badge(`nessun firmware ${d.target}`, 'warn')),
      ),
      card(
        table(
          [
            { label: 'Piattaforma', render: (i) => h('strong', {}, i.platform) },
            { label: 'Versione', render: (i) => h('span', {}, i.version, ' ', i.target ? badge('richiesta', 'good') : badge('altra', '')) },
            { label: 'Build', render: (i) => h('code', { class: 'small' }, i.build) },
            { label: 'File', render: (i) => h('div', {}, i.filename, h('div', { class: 'small muted' }, `${mb(i.size)} · SHA-256 ${i.sha256.slice(0, 12)}…`), i.present ? null : badge('file mancante', 'bad')) },
            { label: 'Caricato', render: (i) => fmtDate(i.createdAt) },
            {
              label: '',
              render: (i) => {
                const b = h('button', { class: 'danger small' }, 'Elimina');
                b.onclick = () => {
                  if (!confirm(`Eliminare ${i.build}?`)) return;
                  busy(b, async () => {
                    await api(`/api/admin/firmware/${i.id}`, { method: 'DELETE' });
                    toast('Firmware eliminato');
                    await load();
                  });
                };
                return b;
              },
            },
          ],
          d.items,
        ),
      ),
    );
  }

  upload.onclick = () =>
    busy(upload, async () => {
      const f = file.files?.[0];
      if (!f) return toast('Scegli il file .bin', 'bad');
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await api(`/api/admin/firmware?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/x-airos-firmware' } });
      toast(`Caricato ${r.item.build}`, 'good');
      file.value = '';
      await load();
    });

  await load();
  return h('div', {}, pageHead('Firmware airOS', 'Immagini per l’aggiornamento delle CPE dall’app'), box);
}
