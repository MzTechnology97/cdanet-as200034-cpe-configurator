import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDeviceMac } from '../src/domain/policy.ts';
import { provisionRequestSchema } from '../src/services/provisioning.ts';

describe('MAC della CPE', () => {
  it('only a unicast, non-zero MAC is a device MAC (segnalazione #7: a code of the box was taken as MAC)', () => {
    assert.equal(isDeviceMac('1C:6A:1B:CA:95:C3'), true);
    assert.equal(isDeviceMac('24:A4:3C:11:22:33'), true);
    assert.equal(isDeviceMac('81:78:82:02:72:50'), false, 'first byte odd: multicast');
    assert.equal(isDeviceMac('00:00:00:00:00:00'), false);
    const r = provisionRequestSchema.safeParse({ model: 'LiteBeam 5AC', mac: '81:78:82:02:72:50' });
    assert.equal(r.success, false);
    assert.ok(!r.success && r.error.issues.some((i) => i.message === 'Non è il MAC di un apparato'));
  });
});
