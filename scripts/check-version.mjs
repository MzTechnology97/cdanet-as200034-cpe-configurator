// Release gate: one version for the whole platform (/VERSION).
import { readFileSync } from 'node:fs';

const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const server = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8')).version;
const errors = [];
if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push(`VERSION "${version}" is not x.y.z`);
if (server !== version) errors.push(`server/package.json is ${server}, VERSION is ${version}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`version ${version} OK`);
