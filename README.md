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

Initial secure PWA shell is in place. The UI can generate the allowed SSID set, collect non-secret device metadata and transient PPPoE credentials, preview the intended provisioning plan, and store only a redacted local history. Direct device provisioning is intentionally disabled until the provisioning bridge/API is implemented and validated against the exact airOS version(s).

## Development

Serve this directory over HTTPS (or localhost) to enable service-worker/PWA behavior. No build step is required for the initial shell.
