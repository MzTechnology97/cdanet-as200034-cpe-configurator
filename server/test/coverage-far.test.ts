import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

// ~28 km north of Nodo 2 (37.6, 14.1) and ~38 km from Nodo 7: beyond any realistic link
const FAR = { lat: 37.85, lon: 14.1 };

describe('Copertura oltre 20 km (Carmelo, 21/10/2026)', () => {
  it('the admins see their APs beyond 20 km, as too far; the installers keep the radius and 20 km', async () => {
    const fake = fakeUisp();
    const db = openDatabase(':memory:');
    const { app, ctx } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: fake.uisp });
    const login = async (u: { username: string; password: string }) => ({
      authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: u })).json().token}`,
    });
    const A = await login(ADMIN);
    const get = (url: string, h: Record<string, string>) => app.inject({ method: 'GET', url, headers: h });

    // the configured radius by default, as far as asked up to 100 km
    assert.equal((await get(`/api/coverage?lat=${FAR.lat}&lon=${FAR.lon}`, A)).json().aps.length, 0, 'nothing within the default radius');
    const wide = await get(`/api/coverage?lat=${FAR.lat}&lon=${FAR.lon}&km=50&limit=50`, A);
    assert.equal(wide.statusCode, 200, wide.body);
    const w = wide.json() as { maxKm: number; aps: Array<{ name: string; distanceM: number; rating: string; estimate: { tooFar: boolean; tooFarKm?: number } | null }> };
    assert.equal(w.maxKm, 50);
    const n2 = w.aps.find((a) => a.name === 'AP N2 D01');
    assert.ok(n2 && n2.distanceM > 20_000, JSON.stringify(w.aps.map((a) => [a.name, a.distanceM])));
    assert.deepEqual([n2.estimate?.tooFar, n2.estimate?.tooFarKm, n2.rating], [true, 20, 'improbabile'], 'shown, never promised');
    assert.equal((await get(`/api/coverage?lat=${FAR.lat}&lon=${FAR.lon}&km=150`, A)).json().maxKm, 100, 'never beyond 100 km');

    // the augmented reality: their POPs beyond 20 km by default
    const ar = await get(`/api/pointing?lat=${FAR.lat}&lon=${FAR.lon}`, A);
    assert.equal(ar.statusCode, 200, ar.body);
    assert.equal(ar.json().maxKm, 100);
    const names = (ar.json().aps as Array<{ name: string }>).map((a) => a.name);
    assert.ok(names.includes('AP N2 D01'), `AR: ${names}`);
    assert.equal((await get(`/api/pointing?lat=${FAR.lat}&lon=${FAR.lon}&km=10`, A)).json().aps.length, 0, 'a smaller radius when asked');

    // an installer: his assigned APs only, never beyond the radius and 20 km, whatever he asks
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const tid = (db.prepare("SELECT id FROM users WHERE username = 'tecnico'").get() as { id: number }).id;
    ctx.db.prepare("INSERT INTO outage_assignments(user_id, key, name, added_at) VALUES(?, 'ap:ap-n2', 'AP N2 D01', ?)").run(tid, new Date().toISOString());
    const T = await login({ username: 'tecnico', password: 'Installer-Pass-123' });
    const inst = (await get(`/api/coverage?lat=${FAR.lat}&lon=${FAR.lon}&km=50`, T)).json() as { maxKm: number; aps: unknown[] };
    assert.ok(inst.maxKm <= 20, String(inst.maxKm));
    assert.equal(inst.aps.length, 0);
    await app.close();
  });
});
