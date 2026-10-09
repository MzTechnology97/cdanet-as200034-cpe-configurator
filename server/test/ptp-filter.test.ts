import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPtp } from '../src/services/uisp.ts';

describe('AP dei clienti e collegamenti PtP', () => {
  it('keeps the CDA Net customer APs and drops backhaul links set up as APs', () => {
    const d = (name: string, ssid: string | null, wirelessMode = 'ap-ptmp') => ({ name, ssid, wirelessMode });
    // customer APs: CDA-NET-N<pop>-D<district>
    assert.equal(isPtp(d('N6-D02', 'CDA-NET-N6-D02')), false);
    assert.equal(isPtp(d('AP N2 D01', 'CDA-NET-N2-D01')), false);
    assert.equal(isPtp(d('N12-Centro', 'CDA-NET-N12-DCentro')), false);
    assert.equal(isPtp(d('AP senza ssid in UISP', null)), false);
    // backhaul seen in Copertura: AP mode, but PtP by name and SSID
    assert.equal(isPtp(d('PTP MATRICE VS A.7', 'PTP MATRICE VS A.7_2')), true);
    assert.equal(isPtp(d('PTP ASILO VS SS 191', 'PTMP SAN GIOVANNELLO')), true);
    assert.equal(isPtp(d('PtP Monte-Valle', null)), true);
    assert.equal(isPtp(d('Collegamento', 'BACKBONE-1')), true, 'any SSID outside the CDA Net naming');
    assert.equal(isPtp(d('N6-D02', 'CDA-NET-N6-D02', 'ap-ptp')), true, 'PtP radio mode');
    // stations: customers on a CDA Net AP stay customers, far ends of a link do not
    assert.equal(isPtp(d('ROSSI MARIO', 'CDA-NET-N6-D02', 'sta-ptmp')), false);
    assert.equal(isPtp(d('PTP MATRICE VS A.7 lato B', 'PTP MATRICE VS A.7_2', 'sta-ptmp')), true);
    assert.equal(isPtp(d('Optimum Srl', 'CDA-NET-N6-D02', 'sta-ptmp')), false, '"pt" inside a word is not PtP');
  });
});
