import { api } from '../api.js';
import { busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

export async function wirelessView() {
  const list = h('div', {});
  const node = h('select', {});
  const district = h('select', {});
  for (let n = 2; n <= 99; n++) node.append(h('option', { value: n }, n));
  for (let d = 1; d <= 99; d++) district.append(h('option', { value: d }, String(d).padStart(2, '0')));
  const ssidPreview = h('input', { readonly: true });
  const psk = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 63 });
  const ssid = () => `CDA-NET-N${node.value}-D${String(district.value).padStart(2, '0')}`;
  const sync = () => (ssidPreview.value = ssid());
  node.onchange = district.onchange = sync;
  sync();

  async function load() {
    const nets = await api('/api/admin/wireless-networks');
    mount(
      list,
      table(
        [
          { label: 'SSID', key: 'ssid' },
          { label: 'Aggiornata', render: (n) => fmtDate(n.updatedAt) },
          {
            label: '',
            render: (n) => {
              const del = h('button', { class: 'danger' }, 'Elimina');
              del.onclick = (e) => {
                e.stopPropagation();
                if (!confirm(`Eliminare la chiave WPA2 di ${n.ssid}?`)) return;
                busy(del, async () => {
                  await api(`/api/admin/wireless-networks/${encodeURIComponent(n.ssid)}`, { method: 'DELETE' });
                  toast('Chiave eliminata');
                  await load();
                });
              };
              return del;
            },
          },
        ],
        nets,
        (n) => {
          const m = /^CDA-NET-N(\d+)-D(\d+)$/.exec(n.ssid);
          if (m) {
            node.value = m[1];
            district.value = String(Number(m[2]));
            sync();
            psk.focus();
          }
        },
      ),
    );
  }

  const save = h('button', { class: 'primary', type: 'submit' }, 'Salva chiave cifrata');
  const form = h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        busy(save, async () => {
          await api(`/api/admin/wireless-networks/${encodeURIComponent(ssid())}`, { method: 'PUT', body: { wpa2Password: psk.value } });
          psk.value = '';
          toast(`WPA2 di ${ssid()} salvata`);
          await load();
        });
      },
    },
    field('Nodo', node),
    field('Distretto', district),
    field('SSID', ssidPreview),
    field('Chiave WPA2 (8-63 caratteri)', psk),
    save,
  );

  await load();
  return h(
    'div',
    {},
    pageHead('Reti Wi-Fi', 'Le chiavi WPA2 sono cifrate (AES-256-GCM) e non vengono mai mostrate. Per sostituirne una salvala di nuovo.'),
    card(h('h2', {}, 'Imposta chiave'), form),
    card(list),
  );
}
