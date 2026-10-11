import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

/** Reads the events of an open stream until [until] is seen or [ms] pass. */
async function readEvents(res: Response, ms: number, until?: string): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const seen: string[] = [];
  let buf = '';
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), stop - Date.now()))]);
    if (!r || r.done) break;
    buf += dec.decode(r.value, { stream: true });
    for (const m of buf.matchAll(/^event: (\w+)$/gm)) if (!seen.includes(m[1]!) || m[1] === until) seen.push(m[1]!);
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    if (until && seen.includes(until)) break;
  }
  await reader.cancel().catch(() => {});
  return seen;
}

describe('Aggiornamenti in tempo reale (/api/events)', () => {
  it('each user hears only what concerns them, with no data in the event', async () => {
    const t = await testApp();
    const admin = await t.login();
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const tecId = (t.db.prepare("SELECT id FROM users WHERE username = 'tecnico'").get() as { id: number }).id;
    const base = await t.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      assert.equal((await fetch(`${base}/api/events`)).status, 401, 'only logged-in users');
      const open = async (token: string) => {
        const r = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
        assert.match(r.headers.get('cache-control') ?? '', /no-transform/);
        return r;
      };
      const a = await open(admin);
      const i = await open(tec);
      // wait for both subscriptions, then: a notification to the NOC, an IA-AP analysis, an outage
      for (let n = 0; n < 50 && t.ctx.live.count() < 2; n++) await new Promise((ok) => setTimeout(ok, 20));
      assert.equal(t.ctx.live.count(), 2);
      t.ctx.notify.inbox.push('noc', { kind: 'install_ko', title: 'KO', lines: [] });
      t.ctx.live.publish('advisor', 'admins');
      t.ctx.live.publish('outages', 'all');
      t.ctx.notify.inbox.push([tecId], { kind: 'work_order_assigned', title: 'Intervento', lines: [] });
      const [ea, ei] = await Promise.all([readEvents(a, 1500), readEvents(i, 1500)]);
      assert.deepEqual(ea, ['ready', 'notifications', 'advisor', 'outages']);
      assert.deepEqual(ei, ['ready', 'outages', 'notifications'], 'the installer: no NOC notification, no IA-AP');
      // a closed stream leaves the list
      for (let n = 0; n < 50 && t.ctx.live.count() > 0; n++) await new Promise((ok) => setTimeout(ok, 20));
      assert.equal(t.ctx.live.count(), 0);
    } finally {
      await t.app.close();
    }
  });
});
