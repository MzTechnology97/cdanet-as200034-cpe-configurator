# Offline-first provisioning

## Constraint
During factory provisioning the installer joins the CPE management Wi-Fi. The workstation/phone may therefore lose Internet access while the CPE remains reachable locally at `192.168.172.1`.

## Required workflow
1. While online, installer opens/updates the PWA, authenticates with approved account + MFA, and starts a short-lived provisioning job.
2. PWA caches the application shell and the non-secret job metadata needed for the session.
3. Installer joins the factory CPE management Wi-Fi.
4. Provisioning continues locally; Internet is not a requirement for the device-write phase.
5. CPE first boot is activated with Country Licensed and CDA Net device credentials.
6. Firmware is read only after factory activation. 8.7.11/8.7.25 are normalized to 8.7.4 using the locally available approved image, with hardware and SHA-256 verification.
7. Configure Station/WPA2, Router Mode, PPPoE and final HTTP/HTTPS management ports 20080/20443.
8. Verify local device state and complete/reload.
9. Once the CPE associates and PPPoE comes up, Internet/management reachability returns. The client then synchronizes the redacted audit/result to the central backend.

## Browser boundary
The production design must not rely on arbitrary cross-origin browser requests from the HTTPS PWA directly to the CPE HTTP UI. Browser mixed-content, CORS and Private Network Access rules vary across Chrome/Chromium, Firefox and Safari. Device-specific HTTP/SSH/API interaction therefore belongs in a local provisioning bridge/agent or another explicitly supported local transport. The PWA is the UI/orchestrator, not the place where privileged airOS secrets or device automation logic are exposed.

## Offline session security
- MFA must be completed online before a provisioning session is issued.
- Provisioning authorization must be short-lived, signed and scoped to one installer/session/device workflow.
- WPA2 and PPPoE passwords remain memory-only and must never be placed in Cache Storage, IndexedDB, localStorage, service-worker cache or audit logs.
- Offline audit events may contain only redacted metadata and are synchronized when connectivity returns.
- Expired/revoked sessions must require online re-authentication before another CPE can be started.

## Firmware availability
Because Internet may be absent during downgrade, the approved airOS 8.7.4 image must be available to the local provisioning component before the installer disconnects from Internet. The image remains outside the public PWA cache and is verified against the approved SHA-256 before flashing.
