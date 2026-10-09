import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SSID_PARTS, SSID_RX, ssidFor } from '../src/domain/policy.ts';
import { parseWirelessCsv } from '../src/domain/wireless-csv.ts';
import { isPtp } from '../src/services/uisp.ts';

describe('SSID dei rilanci (CDA-NET-N<pop>-D<distretto>-R<n>)', () => {
  it('accepts relay APs everywhere a CDA Net SSID is expected', () => {
    for (const ok of ['CDA-NET-N6-D02', 'CDA-NET-N6-D02-R1', 'CDA-NET-N12-D10-R12']) assert.ok(SSID_RX.test(ok), ok);
    for (const bad of ['CDA-NET-N6-D02-R0', 'CDA-NET-N6-D02-X1', 'CDA-NET-N6-D02-R', 'CDA-NET-N6-D02-R123']) assert.ok(!SSID_RX.test(bad), bad);
    assert.equal(ssidFor(6, 2), 'CDA-NET-N6-D02');
    assert.equal(ssidFor(6, 2, 1), 'CDA-NET-N6-D02-R1');
    assert.deepEqual(SSID_PARTS.exec('CDA-NET-N6-D02-R3')?.slice(1), ['6', '02', '3']);
    assert.equal(isPtp({ name: 'N6-D02 rilancio', ssid: 'CDA-NET-N6-D02-R1', wirelessMode: 'ap-ptmp' }), false, 'a relay AP serves customers');
  });

  it('imports the WPA2 key of a relay from the CSV', () => {
    const csv = parseWirelessCsv('ssid;wpa2\nCDA-NET-N6-D02-R1;ChiaveDelRilancio1\n');
    assert.deepEqual(csv.errors, []);
    assert.equal(csv.rows[0]?.ssid, 'CDA-NET-N6-D02-R1');
    const both = parseWirelessCsv('nodo;distretto;ssid;wpa2\n6;2;CDA-NET-N6-D02-R1;ChiaveDelRilancio1\n7;2;CDA-NET-N6-D02-R1;Altra\n');
    assert.equal(both.rows.length, 1);
    assert.match(both.errors[0]?.error ?? '', /diverso da nodo\/distretto/);
  });
});
