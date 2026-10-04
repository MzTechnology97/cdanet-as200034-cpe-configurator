# CDA Net backend v0.5.0

Authenticated control plane for installer accounts, encrypted provisioning data, redacted audit history, network diagnostics and Android updates.

## Run

1. Node.js 20+.
2. `cd server && npm install`.
3. Copy `.env.example` to `.env` and replace deployment placeholders.
4. Provide a base64-encoded 32-byte master key through `SECRETS_KEY_FILE`.
5. Use a random `JWT_SECRET` of at least 32 characters.
6. `npm start`.

The first start creates an Admin only when no Admin exists. Changing `ADMIN_PASSWORD` later does **not** reset an existing database account. Use the Admin UI or `deploy/reset-admin-password.sh`.

## Roles

- `installer`: authentication, provisioning, own audit history and authenticated tools.
- `admin`: installer account management, wireless secrets, airOS profiles and global audit history.

## Android update channel

`ANDROID_RELEASE_DIR` contains an APK and `latest.json`. The backend exposes the release metadata and APK before login so a broken/expired login does not prevent app recovery.

Only stable-signed APKs should be published. Use `deploy/publish-android-release.sh` to validate SHA-256 and atomically publish metadata.

## Security

Secrets are not returned by audit endpoints. PPPoE passwords stay transient. WPA2 and airOS templates are AES-256-GCM encrypted at rest. Login attempts are rate-limited. Audit retention is enforced from `GDPR_AUDIT_RETENTION_DAYS`.

The production PWA origin should be HTTPS. The Android Capacitor origins are separately allow-listed for the native client.
