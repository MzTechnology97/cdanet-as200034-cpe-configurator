# CDA Net CPE Configurator — Debian 12/13

## Requisiti

- Debian 12/13.
- Repository/release source already synchronized in `/opt/cdanet-cpe-configurator`.
- Docker Engine + Compose (the bootstrap can install them).
- Firmware airOS 8.7.4 stored outside Git.
- For a real PWA: DNS hostname plus TCP 80/443 usable by Caddy for TLS.

## Bootstrap

`deploy/install-debian.sh` **does not clone the private repository and does not store a GitHub PAT**. The source must already exist in `/opt/cdanet-cpe-configurator`.

The bootstrap:
- installs/starts Docker;
- creates the CDA Net master key if missing;
- creates private firmware/release directories;
- asks interactively for the first Admin credentials;
- creates `deploy/.env`;
- builds and starts the containers;
- verifies backend health.

Initial LAN recovery access may use `http://172.31.0.29`, but that is not an installable secure PWA.

## Redeploy

After synchronizing the repository on the server:

```bash
cd /opt/cdanet-cpe-configurator
sudo ./deploy/redeploy-local-pwa.sh
```

This preserves `.env`, rebuilds containers and performs health checks.

## HTTPS PWA

Once the real hostname resolves correctly and Caddy can obtain a certificate:

```bash
sudo ./deploy/enable-pwa-https.sh pwa.example.it
```

Replace the example with the CDA Net production hostname. The script backs up `.env`, changes the PWA origin/listener and verifies HTTPS health.

## Admin password recovery

```bash
sudo ./deploy/reset-admin-password.sh
```

This updates the existing SQLite account without deleting audit/profile data.

## Android release publication

After GitHub Actions has produced a **stable-signed** APK plus `latest.json`:

```bash
sudo ./deploy/publish-android-release.sh CDA-Net-CPE-x.y.z.apk latest.json
```

The script verifies SHA-256 and publishes atomically to the backend release directory.

There is currently no hidden GitHub/PAT timer on the server. Server updates are controlled redeploys; APK updates use the backend release channel.
