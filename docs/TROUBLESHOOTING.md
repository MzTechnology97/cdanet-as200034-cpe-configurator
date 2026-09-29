# Troubleshooting — CDA Net CPE Configurator

## Safety rule

Never paste device passwords, PPPoE passwords, UISP enrollment keys, SNMP communities/credentials, JWT secrets or other deployment secrets into issues, screenshots, logs or chat transcripts. Sanitize diagnostics before sharing them.

## CPE not reachable

- Confirm installer device is on the intended management network.
- Confirm CPE power/PoE and Ethernet link.
- Confirm expected management address and that no conflicting interface/VPN is taking the route.
- Retry discovery before resetting hardware.
- If the CPE is in an unknown state, stop provisioning and use the approved recovery/reset procedure.

## Model or firmware blocked

Supported models are NanoStation Loco 5AC, NanoStation 5AC, NanoBeam 5AC, LiteBeam 5AC and PowerBeam 5AC.

Production baseline is airOS 8.7.4. Versions 8.7.11 and 8.7.25 are compatibility-test targets only. Do not silently continue on an unknown firmware: record the detected version and stop before configuration changes.

## Wireless association fails

- Verify selected node/district and generated SSID.
- Confirm the target AP is broadcasting the expected SSID/profile.
- Check frequency/channel compatibility and regulatory/country state.
- Check signal/noise and alignment independently of provisioning.
- Do not change production RF parameters merely to make the configurator test pass.

## PPPoE fails

- Re-enter subscriber credentials; the password must not be recoverable from history because it is intentionally not stored.
- Confirm the wireless link is associated before diagnosing PPPoE.
- Confirm the subscriber username belongs to the intended service/profile.
- Record only sanitized PPPoE failure information.

## UISP enrollment fails

- Verify the provisioning bridge has the UISP enrollment secret configured server-side.
- Never place the enrollment key in static JavaScript, browser localStorage or an audit record.
- Confirm CPE has management connectivity and can reach the UISP endpoint.
- Retry enrollment only after connectivity is established.

## SNMP verification fails

- Verify monitoring credentials exist server-side.
- Confirm the CPE management path permits the expected SNMP traffic.
- Verify settings were committed before testing.
- Do not print the SNMP credential in diagnostics.

## Interrupted provisioning

Treat the device state as unknown. Reconnect, read the current state, compare it with the intended plan, then either resume from a verified safe stage or restore the approved baseline. Never blindly replay destructive first-run actions.

## Minimum diagnostic record

Capture timestamp, installer ID, model, firmware, MAC/serial, SSID, PPPoE username, failed stage, sanitized error text and whether the CPE remained reachable. Never capture secret values.
