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

v0.2.0 field-test architecture is implemented:

- HTTPS-capable PWA shell with update-safe service worker.
- Authenticated backend with Admin/installer roles, encrypted WPA2 secrets and redacted audit history.
- Admin upload of lab-validated airOS 8.7.4 provisioning profiles per supported model.
- Android native offline workflow: prepare while online, join the CPE management Wi-Fi, probe `192.168.172.1`, perform first-run activation through the official local airOS UI, then apply the prepared profile over SSH.
- Native application verifies target firmware, board profile and expected MAC before writing `/tmp/system.cfg`.
- Configuration is persisted with `cfgmtd -f /tmp/system.cfg -w` before reboot.

The remaining production gate is hardware validation of one approved airOS 8.7.4 profile per supported model. Firmware 8.7.11/8.7.25 normalization remains blocked until the correct WA/XC image and downgrade procedure have been bench-tested for each board family.

## Development

Serve this directory over HTTPS (or localhost) to enable service-worker/PWA behavior. No build step is required for the initial shell.
