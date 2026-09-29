# CDA Net CPE Configurator — v0.1.0-TC1

Status: **PWA test candidate**

This candidate is intended to validate installation, mobile UX, configuration planning, firmware guardrails and sanitized history before enabling production CPE provisioning.

## Validated automatically

GitHub Actions run #2 passed:
- frontend JavaScript syntax
- service worker syntax
- PWA manifest parsing
- required CDA Net assets
- backend dependency installation
- backend JavaScript syntax

## Test target

Production baseline: airOS **8.7.4**.

Supported CPE models:
- NanoStation Loco 5AC
- NanoStation 5AC
- NanoBeam 5AC
- LiteBeam 5AC
- PowerBeam 5AC

Firmware 8.7.11 and 8.7.25 remain compatibility-test only.

## Important limitation of TC1

TC1 must **not** be treated as production provisioning software yet. The current frontend validates and records a redacted provisioning plan. Real device writes require the controlled provisioning bridge and a successful bench test against an airOS 8.7.4 CPE.

Do not place UISP enrollment keys, device passwords, PPPoE passwords, SNMP credentials, JWT secrets or other production secrets in static PWA files or browser storage.

## Installer test checklist

1. Serve the repository over HTTPS (or localhost for development).
2. Open the PWA on the test smartphone and install/add it to the home screen.
3. Confirm CDA Net branding and standalone launch.
4. Select each supported model and confirm no unsupported free-text model can be entered.
5. Confirm 8.7.4 is marked production and 8.7.11/8.7.25 trigger test-only handling.
6. Build a configuration plan using a non-production test PPPoE account.
7. Confirm the PPPoE password disappears after registration and is absent from history.
8. Test offline relaunch after the first successful load.
9. Do not connect TC1 to a production subscriber CPE for write operations.

## Next gate

TC2/field provisioning gate requires: authenticated installer session, controlled bridge connection to a lab CPE, model/firmware readback, dry-run, staged apply, post-apply verification, redacted audit and recovery test.
