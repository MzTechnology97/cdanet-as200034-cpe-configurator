# CDA Net CPE Configurator

Private field platform for CDA Net installers: Android APK, HTTPS PWA/backend and optional loopback Web Bridge.

## v0.5.0 architecture

- **Android APK** — native diagnostics, Ubiquiti offline provisioning, RouterOS SSH tools, TVCC/RTSP, automatic runtime-permission request and Android update client.
- **HTTPS PWA / backend** — authentication, installer accounts, encrypted wireless/profile secrets, redacted audit history, server-side network tools and Android release channel.
- **Web Bridge** — loopback-only companion for PC/PWA operations that a browser cannot perform directly on the LAN.

The HTTP endpoint on an internal IP can be used as a recovery/admin web page, but an installable/offline PWA requires **HTTPS** (or localhost).

## Ubiquiti CPE policy

Supported models:
- NanoStation Loco 5AC
- NanoStation 5AC
- NanoBeam 5AC
- LiteBeam 5AC
- PowerBeam 5AC

Production target is airOS **8.7.4**. 8.7.11 and 8.7.25 are detected but configuration write is blocked until the board-specific normalization/downgrade procedure has been bench-tested.

Provisioning verifies firmware, board profile and expected MAC before writing `system.cfg`, then persists with `cfgmtd -f /tmp/system.cfg -w -p /etc/ && sync`.

Current CDA Net policy:
- wireless WAN direct to PPPoE; **no VLAN**;
- watchdog `8.8.8.8`;
- SNMP v2c enabled, community `public`, contact `172.31.0.7`;
- SNMP location and Device Name derived as `COGNOME NOME` from the RADIUS username before `@cda-net.it`;
- Calculate EIRP Limit OFF;
- Automatic Power Control (Station) ON;
- HTTP 20080 / HTTPS 20443;
- UISP/SNMP/device secrets supplied only at runtime.

Legacy field files are used only as a sanitized behavioral reference. Legacy VLANs, hard-coded passwords/PSKs and HTTP self-update scripts are not imported.

## Accounts and audit

Admin can create, list, enable/disable and reset installer accounts. The application records redacted provisioning metadata only. Offline APK/Web Bridge results are queued without passwords and synchronized after connectivity/login returns.

Audit retention uses `GDPR_AUDIT_RETENTION_DAYS` (default 365).

## Android startup and update

At native startup the APK requests the Android permissions required by the toolbox automatically. Already-granted permissions do not prompt again.

The APK checks the backend release channel automatically. A newer APK is downloaded to private app cache, SHA-256 verified, then passed to Android Package Installer. Android still requires the user to approve installation/unknown-app permission where required.

**Stable signing is mandatory for real in-place updates.** GitHub Actions supports a signed release when these repository secrets are configured:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Without them CI produces a tester debug APK only; it must not be treated as the permanent auto-update release channel.

## Network / RouterOS / TVCC

Network tools include Ping, DNS, Traceroute, interfaces, subnet discovery, ARP/neighbors, NetBIOS, SNMP v2c, BGP/RIPEstat, Looking Glass, MAC vendor and speed tests.

RouterOS 6.x/7.x exposes read-oriented Quick Set, CAPsMAN, Interfaces, Wireless, Bridge, PPP, Switch, Mesh, IP, MPLS, Routing, System, Queues, Files, Log, RADIUS and Tools. The free-form terminal is deliberately read-only; Supout generation is an explicit confirmed action.

TVCC supports ONVIF/Hikvision discovery, camera port probing, RTSP viewer and bandwidth/storage calculation.

## Release gates

See `docs/PROJECT-REVIEW-v0.5.0.md`. A production release requires green CI plus physical lab validation. In particular, successful compilation is not considered proof of CPE/RouterOS/camera behavior on real hardware.
