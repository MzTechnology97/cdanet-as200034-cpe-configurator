#!/usr/bin/env node
// Uploads the signed bundle (.aab) to a Google Play track, internal testing by default.
// No dependencies: the service account's JWT is signed here and the Play Developer API is called
// with fetch. Used by the Android workflow once PLAY_SERVICE_ACCOUNT_JSON is set; by hand too:
//   PLAY_SERVICE_ACCOUNT_JSON="$(cat key.json)" node tools/play-upload.mjs app-play-release.aab 1.35.15
// The key never leaves the environment and is never printed.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [file, name = ''] = process.argv.slice(2);
const pkg = process.env.PLAY_PACKAGE || 'it.cdanet.cpeconfigurator';
const track = process.env.PLAY_TRACK || 'internal';
// «draft» until the app's first release has been rolled out from the Play Console
const status = process.env.PLAY_RELEASE_STATUS || 'completed';
if (!file || !process.env.PLAY_SERVICE_ACCOUNT_JSON) {
  console.error('uso: PLAY_SERVICE_ACCOUNT_JSON=... node tools/play-upload.mjs <file.aab> [nome release]');
  process.exit(2);
}
const sa = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);

const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud, iat: now, exp: now + 600 })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')}`;
  const r = await fetch(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!r.ok) throw new Error(`token Google: HTTP ${r.status}`);
  return (await r.json()).access_token;
}

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
const token = await accessToken();
async function call(method, url, body, headers = { 'content-type': 'application/json' }) {
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`${method} ${url.replace(API, '')}: HTTP ${r.status} ${text.slice(0, 400)}`);
    err.text = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

const edit = await call('POST', `${API}/edits`, '{}');
let versionCode;
try {
  const up = await call('POST', `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${pkg}/edits/${edit.id}/bundles?uploadType=media`, readFileSync(file), {
    'content-type': 'application/octet-stream',
  });
  versionCode = up.versionCode;
} catch (e) {
  // the same version already on Play (a re-run of the workflow): nothing to do
  if (/already been used|apkUpgradeVersionConflict|versionCodeExists/i.test(e.text ?? '')) {
    console.log('Questa versione è già su Google Play: niente da caricare.');
    await call('DELETE', `${API}/edits/${edit.id}`).catch(() => {});
    process.exit(0);
  }
  throw e;
}
await call('PUT', `${API}/edits/${edit.id}/tracks/${track}`, JSON.stringify({ track, releases: [{ name: name || String(versionCode), versionCodes: [String(versionCode)], status }] }));
await call('POST', `${API}/edits/${edit.id}:commit`);
console.log(`Google Play: versionCode ${versionCode} pubblicato sul canale «${track}» (${status}).`);
