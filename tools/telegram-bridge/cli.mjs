// Reading and sending through the bridge (docker exec -i telegram-bridge node cli.mjs …):
//   read [--peek] [--all] [--chat ID]   messages not read yet (--peek: keep them unread)
//   send gruppo|me|ID [testo…]          sends the text (or what arrives on stdin), split at 4000
//   photo gruppo|me|ID PATH [didascalia] sends a picture copied into the container
//   status                              poller alive?, unread, last message
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATA = process.env.DATA_DIR ?? '/data';
const ALIASES = { gruppo: process.env.GROUP_CHAT, me: process.env.OWNER_CHAT };
const inbox = join(DATA, 'inbox.jsonl');
const cursorFile = join(DATA, 'read-cursor.json');
const [cmd, ...args] = process.argv.slice(2);

const rows = () => (existsSync(inbox) ? readFileSync(inbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const cursor = () => (existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, 'utf8')).id : 0);
const chatOf = (s) => ALIASES[s] ?? s;
const api = async (method, body, form) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, form ? { method: 'POST', body: form } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
};
const stdin = async () => {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
};
const fmt = (m) =>
  `#${m.id} ${m.at.replace('T', ' ').slice(0, 16)} · ${m.chatTitle ?? 'privato'} · ${m.from?.name ?? '?'}${m.from?.username ? ` (@${m.from.username})` : ''}${m.edited ? ' [modificato]' : ''}${m.replyTo ? ` [risposta a ${m.replyTo}]` : ''}\n${m.text || '(senza testo)'}${m.files.length ? `\n[allegati: ${m.files.join(', ')}]` : ''}`;

if (cmd === 'read') {
  const all = args.includes('--all');
  const chat = args.includes('--chat') ? chatOf(args[args.indexOf('--chat') + 1]) : null;
  const from = all ? 0 : cursor();
  const list = rows().filter((m) => m.id > from && (!chat || m.chat === chat));
  console.log(list.length ? list.map(fmt).join('\n\n') : 'Nessun messaggio nuovo.');
  if (!args.includes('--peek') && list.length) writeFileSync(cursorFile, JSON.stringify({ id: Math.max(cursor(), ...list.map((m) => m.id)) }));
} else if (cmd === 'send') {
  const chat = chatOf(args[0]);
  const text = (args.slice(1).join(' ') || (await stdin())).trim();
  if (!chat || !text) throw new Error('uso: send gruppo|me|ID testo (o testo da stdin)');
  for (let i = 0; i < text.length; i += 4000) await api('sendMessage', { chat_id: chat, text: text.slice(i, i + 4000), disable_web_page_preview: true });
  console.log('Inviato.');
} else if (cmd === 'photo') {
  const [to, path, ...cap] = args;
  const form = new FormData();
  form.set('chat_id', chatOf(to));
  form.set('photo', new Blob([readFileSync(path)]), path.split('/').pop());
  if (cap.length) form.set('caption', cap.join(' '));
  await api('sendPhoto', null, form);
  console.log('Inviata.');
} else if (cmd === 'status') {
  const hb = existsSync(join(DATA, 'heartbeat')) ? readFileSync(join(DATA, 'heartbeat'), 'utf8') : null;
  const all = rows();
  const unread = all.filter((m) => m.id > cursor()).length;
  const age = hb ? Math.round((Date.now() - Date.parse(hb)) / 1000) : null;
  console.log(`poller: ${age !== null && age < 180 ? `attivo (ultimo giro ${age} s fa)` : 'FERMO'} · messaggi: ${all.length} · da leggere: ${unread}${all.length ? ` · ultimo: ${all.at(-1).at}` : ''}`);
} else {
  console.log('comandi: read [--peek] [--all] [--chat ID] · send gruppo|me|ID testo · photo gruppo|me|ID PATH [didascalia] · status');
}
