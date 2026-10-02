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

## Web and local bridge architecture

The v0.3.0 backend exposes authenticated `/api/tools/*` endpoints for diagnostics that can safely run from the CDA Net server/NMS perspective.

The companion in `web-agent/` is the local bridge for a PC running the PWA. It listens only on loopback, requires a pairing token, enforces private/CGNAT target restrictions for local tools, and keeps provisioning packages and credentials in memory only.

The Android APK continues to use its native plugin and does not require the PC Web Bridge.

