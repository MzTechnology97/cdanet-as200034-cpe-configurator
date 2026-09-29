# CDA Net CPE Configurator — Security Policy

This repository and its source code are confidential CDA Net internal material. Access must be limited to explicitly authorized personnel.

## Repository controls

- Repository visibility must remain **private**.
- Do not enable GitHub Pages or any public source distribution mechanism.
- Grant repository access only to named personnel who need it; use least privilege.
- Require MFA/2FA on accounts with repository or production access.
- Production deployment credentials must never be committed to Git.
- Review collaborator/app access periodically and revoke unused access.
- Prefer protected/ruleset-controlled `main` and release branches when the GitHub plan supports private-repository rulesets.

## PWA security boundary

A PWA is client-side software. Any HTML, CSS, JavaScript, manifest, icon, configuration value or secret delivered to an installer's browser/device can be inspected by that authorized client. Therefore proprietary provisioning logic and all privileged credentials must live in the authenticated server-side provisioning service, not in downloadable frontend code.

The PWA should contain only the minimum UI/orchestration logic required by installers. Device credentials, UISP enrollment secrets, SNMP credentials, signing/JWT secrets and infrastructure credentials are server-side secrets.

## Production deployment

- Serve the PWA and API only over HTTPS.
- Require authenticated installer accounts; no anonymous provisioning endpoint.
- Enforce authorization server-side for every provisioning/audit operation.
- Use short-lived sessions/tokens and secure cookie/header handling.
- Apply rate limiting and request-size limits.
- Restrict CORS to the production PWA origin.
- Keep the provisioning bridge on a controlled management network; do not expose CPE-management access directly to the public Internet.
- Store production secrets in the deployment platform secret store/environment, with rotation procedures.
- Keep audit records redacted: never log passwords, enrollment keys, communities/tokens or raw authorization headers.

## Release rule

A release must not be marked production-ready until secret scanning, dependency review, authenticated API tests, authorization tests, redaction tests and a lab CPE recovery test have passed.

## Incident handling

If a secret is committed or exposed, removing the file is not sufficient because Git history may retain it. Immediately revoke/rotate the credential, assess exposure, then clean history where appropriate.
