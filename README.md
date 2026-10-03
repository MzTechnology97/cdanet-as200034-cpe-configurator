# CDA Net CPE Configurator

Private PWA for guided provisioning of Ubiquiti airMAX AC CPEs used by CDA Net.

## Goals

- Guided first-run workflow for licensed-country setup.
- Select SSIDs following `CDA-NET-N{2..99}-D{01..99}`.
- Router / PPPoE configuration with installer-entered PPPoE credentials.
- Post-connect SNMP configuration and verification.
- Installer accounts with per-installer history; Admin role with global history.
- Audit records: timestamp, installer, SSID/node/district, PPPoE username, CPE model, MAC/serial, and result.
- Privacy-first: credentials and other secrets must never be stored in Git or configuration history.

## Security model

Static PWA code contains **no production passwords or secrets**. Device/admin, wireless, and SNMP secrets must be supplied at deployment/runtime through a protected backend or local provisioning service. PPPoE passwords are transient and must never be persisted in history or logs.

A browser PWA should not attempt to bypass CORS/TLS protections to automate a CPE web UI. The production architecture should use a controlled local provisioning bridge/backend with strict authentication, CSRF protection, origin allow-listing, request validation, audit logging, and encrypted secret storage.

## Current status

v0.4.0 introduces one UI with three execution engines:

- **Android APK**: uses the native Android diagnostics/provisioning plugin.
- **PWA Web / Backend CDA Net**: authenticated server-side Ping, DNS, Traceroute, interfaces, neighbor/ARP view, network discovery, SNMP v2c, camera probe, ONVIF/Hikvision discovery, BGP/RIPEstat, Looking Glass, MAC vendor lookup and browser-to-server speed test.
- **PWA Web / CDA Net Web Bridge**: loopback-only companion for PC field work where the browser cannot access Wi-Fi, ARP, UDP/SNMP, ONVIF/SADP, external SSH/RDP/RTSP handlers or the local CPE directly.

Provisioning is available in both Android and Web Bridge modes. Both prepare the short-lived package while Internet is available, keep it in memory, then apply it locally after the installer joins the CPE management network. Firmware, board profile and expected MAC are verified before writing `system.cfg`, which is persisted with `cfgmtd -f /tmp/system.cfg -w`.

The remaining production gate is hardware validation of one approved airOS 8.7.4 profile per supported model. Firmware 8.7.11/8.7.25 normalization remains blocked until the correct WA/XC image and downgrade procedure have been bench-tested for each board family.

## MikroTik / RouterOS v0.4.0

The unified UI now includes a RouterOS management module compatible with RouterOS 6.x and 7.x over SSH. It exposes CDA Net styled equivalents of Quick Set, CAPsMAN, Interfaces, Wireless, Bridge, PPP, Switch, Mesh, IP, MPLS, Routing, System, Queues, Files, Log, RADIUS and Tools, plus a system dashboard and a read-only terminal.

Execution is dual-runtime:
- Android APK: direct native JSch session to private/CGNAT RouterOS targets.
- PWA + Web Bridge: direct local SSH from the installer PC.
- PWA backend: server-side SSH to allowed targets; public targets remain disabled unless explicitly enabled in protected NOC deployment.

Passwords and RouterOS secrets are not persisted and common secret fields are redacted from returned output. The v0.4.0 terminal intentionally blocks configuration-changing commands until field validation is complete.

## Development

Serve this directory over HTTPS (or localhost) to enable service-worker/PWA behavior. No build step is required for the initial shell.
