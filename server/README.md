# CDA Net provisioning API

Foundation for authenticated installer accounts and centralized redacted audit history.

## Run

1. Install Node.js 20+.
2. `cd server && npm install`
3. Copy `.env.example` to `.env` and replace every placeholder with deployment-specific values.
4. Generate `JWT_SECRET` with a cryptographically secure random generator (32+ bytes).
5. `npm start`

The first start creates the Admin user from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Change/remove bootstrap credentials from the environment after establishing the production account-management procedure.

## Roles

- `installer`: may authenticate, create audit entries and read only their own history.
- `admin`: may additionally create installer accounts and read global history.

## Secret policy

Never commit `.env`. Device admin password, wireless PSK, SNMP community and PPPoE passwords must not be stored in audit records. PPPoE passwords are deliberately rejected by the strict audit schema.

## Next provisioning bridge milestone

The bridge that actually talks to airOS is not enabled yet. Before implementing it, capture the exact CPE models and airOS AC firmware versions in use and validate the supported management mechanism in a lab CPE. Do not rely on undocumented web-form endpoints in production without version-specific testing. The bridge should only accept a validated high-level provisioning plan, restrict targets to local management networks, prevent arbitrary URL/command injection, enforce short timeouts, redact secrets from logs and return a normalized result.
