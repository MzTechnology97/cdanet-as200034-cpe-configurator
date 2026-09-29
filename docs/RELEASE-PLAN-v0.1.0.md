# CDA Net CPE Configurator — v0.1.0 Field Test

## Scope

Target devices:
- NanoStation Loco 5AC
- NanoStation 5AC
- NanoBeam 5AC
- LiteBeam 5AC
- PowerBeam 5AC

Production firmware baseline: **airOS 8.7.4**.

Compatibility validation only: 8.7.11 and 8.7.25. They are not approved production firmware unless field validation explicitly changes this policy.

## Provisioning sequence

1. Detect/reach CPE through the controlled provisioning bridge.
2. Verify supported model and firmware before making changes.
3. First-run country selection: Licensed.
4. Apply device credentials from server-side deployment secrets.
5. Configure station/radio profile and selected CDA Net SSID.
6. Configure router/PPPoE using installer-supplied transient subscriber credentials.
7. Apply UISP enrollment from a server-side secret; never expose the enrollment key in PWA source, browser storage, audit records, or logs.
8. Apply SNMP settings from server-side secrets.
9. Commit/apply configuration.
10. Verify management reachability, wireless association, PPPoE state, UISP enrollment and SNMP response.
11. Record a redacted audit result.

## Release gates

- No production secret committed to Git or shipped in static PWA assets.
- Installer authentication enabled.
- Supported model selector is constrained to the approved device list.
- Firmware check blocks unsupported versions and clearly distinguishes production-approved 8.7.4 from compatibility-test firmware.
- Provisioning is idempotent where possible and reports the failed stage without logging passwords/secrets.
- A dry-run/preview mode is available before applying changes.
- At least one lab test per supported model on 8.7.4.
- Recovery procedure tested after an interrupted/failed provisioning attempt.
- Troubleshooting guide completed before marking v0.1.0 as field-test ready.

## Field-test acceptance

For each supported model, capture: model, firmware, MAC/serial, target SSID, PPPoE username (not password), installer, start/end time, stage results, final result and sanitized diagnostic notes.

A device passes when it can be provisioned from a known-reset/test state, reconnects after apply/reboot, obtains the expected customer connectivity, appears in UISP, responds to the approved monitoring method, and leaves no secret in client-side persistence or application logs.
