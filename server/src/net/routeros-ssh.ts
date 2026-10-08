import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { Client } from 'ssh2';
import {
  ROUTEROS_SECTIONS,
  SUPOUT_COMMAND,
  readonlyCommand,
  redactRouterOs,
  summarize,
  type RosSummary,
} from '../domain/routeros.ts';
import { isPrivateIPv4, isPrivateIPv6 } from './ip.ts';

export interface RosCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RosResult {
  host: string;
  summary: RosSummary;
  sections: Array<{ title: string; command: string; output: string }>;
  note?: string;
}

function connect(c: RosCredentials & { host: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({
        host: c.host,
        port: c.port,
        username: c.username,
        password: c.password,
        readyTimeout: 8000,
        keepaliveInterval: 4000,
        // Field routers have no pre-enrolled fingerprint; see SECURITY.md (residual risk).
        hostVerifier: () => true,
      });
  });
}

function exec(conn: Client, cmd: string, timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        stream.close();
        reject(new Error('Timeout RouterOS'));
      }, timeout);
      stream.on('data', (d: Buffer) => (out += d.toString('utf8')));
      stream.stderr.on('data', (d: Buffer) => (errOut += d.toString('utf8')));
      stream.on('close', (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        const text = redactRouterOs(out || errOut).trim();
        if (code && code !== 0 && text) reject(new Error(text));
        else resolve(text);
      });
    });
  });
}

async function tryExec(conn: Client, cmd: string): Promise<string> {
  try {
    return await exec(conn, cmd);
  } catch (e) {
    return `[non disponibile] ${redactRouterOs((e as Error).message)}`;
  }
}

async function resolveTarget(host: string, allowPublic: boolean): Promise<string> {
  if (!/^[A-Za-z0-9_.:-]{1,253}$/.test(host)) throw new Error('Host RouterOS non valido');
  const ip = isIP(host) ? host : (await lookup(host)).address;
  const ok = isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
  if (!ok && !allowPublic) throw new Error('Target RouterOS non consentito: solo reti private/CGNAT');
  return ip;
}

export async function routerOsAction(
  creds: RosCredentials,
  action: string,
  command: string | undefined,
  allowPublic: boolean,
): Promise<RosResult> {
  if (!creds.host || !creds.username || !creds.password) throw new Error('Host, username e password RouterOS richiesti');
  const section = ROUTEROS_SECTIONS.find((s) => s.id === action);
  if (!section && !['dashboard', 'terminal', 'supout'].includes(action)) throw new Error('Modulo RouterOS non supportato');
  const terminalCmd = action === 'terminal' ? readonlyCommand(command) : '';
  const host = await resolveTarget(creds.host, allowPublic);
  const conn = await connect({ ...creds, host });
  try {
    const summary = summarize(
      await tryExec(conn, '/system identity print'),
      await tryExec(conn, '/system resource print'),
      await tryExec(conn, '/system routerboard print'),
    );
    const result: RosResult = { host, summary, sections: [] };
    if (action === 'terminal') {
      result.sections.push({ title: 'Terminale RouterOS', command: terminalCmd, output: await tryExec(conn, terminalCmd) });
    } else if (action === 'supout') {
      const output = await exec(conn, SUPOUT_COMMAND, 70_000);
      const files = await tryExec(conn, '/file print detail where name~"cda-supout"');
      result.sections.push({ title: 'Supout.rif', command: SUPOUT_COMMAND, output: `${output || 'Generazione completata'}\n\n${files}` });
      result.note = 'Il file diagnostico resta sul router e può contenere informazioni sensibili.';
    } else if (section) {
      for (const c of section.commands) result.sections.push({ title: c.title, command: c.command, output: await tryExec(conn, c.command) });
    }
    return result;
  } finally {
    conn.end();
  }
}
