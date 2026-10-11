// Telegram bridge: the one poller of the team bot, always on (Docker, restart unless-stopped).
// Keeps every message of the allowed chats in /data/inbox.jsonl (photos and files in
// /data/files) and puts a 👍 on each one so the sender knows it arrived. Reading and sending is
// done with cli.mjs (docker exec), so no Claude session has to stay open. No dependencies.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATA = process.env.DATA_DIR ?? '/data';
const ALLOWED = new Set((process.env.ALLOWED_CHATS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const REACT = process.env.REACT !== '0';
const MAX_FILE = 20 * 1024 * 1024;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN mancante (telegram.env)');
  process.exit(1);
}
const api = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(70_000),
  });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) throw Object.assign(new Error(`${method}: ${j.description}`), { code: j.error_code });
  return j.result;
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
mkdirSync(join(DATA, 'files'), { recursive: true });
const offsetFile = join(DATA, 'offset.json');
let offset = existsSync(offsetFile) ? JSON.parse(readFileSync(offsetFile, 'utf8')).offset : 0;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function saveFile(fileId, name) {
  try {
    const f = await api('getFile', { file_id: fileId });
    if (!f.file_path || (f.file_size ?? 0) > MAX_FILE) return null;
    const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) return null;
    const local = `${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`;
    writeFileSync(join(DATA, 'files', local), Buffer.from(await r.arrayBuffer()));
    return `files/${local}`;
  } catch (e) {
    log(`file: ${e.message}`);
    return null;
  }
}

async function handle(u) {
  const m = u.message ?? u.edited_message ?? u.channel_post;
  if (!m) return;
  const chat = String(m.chat.id);
  if (!ALLOWED.has(chat)) return log(`ignorato chat ${chat}`);
  const files = [];
  const photo = m.photo?.at(-1);
  if (photo) files.push(await saveFile(photo.file_id, `foto-${m.message_id}.jpg`));
  if (m.document) files.push(await saveFile(m.document.file_id, m.document.file_name ?? `file-${m.message_id}`));
  if (m.video) files.push(await saveFile(m.video.file_id, `video-${m.message_id}.mp4`));
  if (m.voice) files.push(await saveFile(m.voice.file_id, `vocale-${m.message_id}.ogg`));
  const row = {
    id: u.update_id,
    at: new Date(m.date * 1000).toISOString(),
    chat,
    chatTitle: m.chat.title ?? null,
    messageId: m.message_id,
    from: m.from ? { id: m.from.id, name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '), username: m.from.username ?? null, bot: !!m.from.is_bot } : null,
    edited: !!u.edited_message,
    text: m.text ?? m.caption ?? '',
    replyTo: m.reply_to_message?.message_id ?? null,
    files: files.filter(Boolean),
  };
  appendFileSync(join(DATA, 'inbox.jsonl'), `${JSON.stringify(row)}\n`);
  if (REACT && !u.edited_message && !m.from?.is_bot) {
    await api('setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch((e) => log(`reazione: ${e.message}`));
  }
}

await api('deleteWebhook', { drop_pending_updates: false }).catch((e) => log(`deleteWebhook: ${e.message}`));
const me = await api('getMe').catch(() => null);
log(`avviato come @${me?.username ?? '?'}, chat ammesse: ${[...ALLOWED].join(', ') || 'nessuna'}`);
let backoff = 1000;
for (;;) {
  try {
    const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'edited_message', 'channel_post'] });
    for (const u of updates) {
      await handle(u).catch((e) => log(`messaggio ${u.update_id}: ${e.message}`));
      offset = u.update_id + 1;
      writeFileSync(offsetFile, JSON.stringify({ offset }));
    }
    writeFileSync(join(DATA, 'heartbeat'), new Date().toISOString());
    backoff = 1000;
  } catch (e) {
    // 409: another program reads the same bot (the old plugin on the PC): wait and retry
    log(`${e.code === 409 ? 'un altro programma legge lo stesso bot (409)' : e.message}; riprovo tra ${backoff / 1000} s`);
    await sleep(backoff);
    backoff = Math.min(60_000, backoff * 2);
  }
}
