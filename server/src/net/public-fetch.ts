import { isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { hostOf, isNotPublicError, isPublicAddress, notPublic, publicLookup } from './public-address.ts';

/**
 * fetch towards the public Internet only (issue #275): every connection is checked, redirects
 * included, a name by the addresses it resolves to ([publicLookup]), an address as it is written.
 */

type Connector = ReturnType<typeof buildConnector>;
const agents = new Map<boolean, Agent>();

function agentFor(ignoreTls: boolean): Agent {
  let a = agents.get(ignoreTls);
  if (!a) {
    const connect = buildConnector({ lookup: publicLookup, ...(ignoreTls ? { rejectUnauthorized: false } : {}) });
    // an address written as such skips the lookup: checked here, for every connection (redirects too)
    const guarded: Connector = (o, cb) => {
      const host = hostOf(o.hostname);
      if (isIP(host) && !isPublicAddress(host)) {
        cb(notPublic(), null);
        return;
      }
      connect(o, cb);
    };
    a = new Agent({ connect: guarded });
    agents.set(ignoreTls, a);
  }
  return a;
}

/**
 * fetch that reaches the public Internet only ([ignoreTls]: certificates not verified). A refused
 * address fails with NOT_PUBLIC; any other failure keeps its cause in the message (a certificate
 * refused, a name not found), so the error says what happened.
 */
export function publicFetch(ignoreTls = false): typeof fetch {
  const dispatcher = agentFor(ignoreTls);
  return (async (input: string | URL, init?: RequestInit) => {
    try {
      return await undiciFetch(input as string, { ...(init as object), dispatcher } as Parameters<typeof undiciFetch>[1]);
    } catch (e) {
      if (isNotPublicError(e)) throw notPublic();
      const cause = (e as { cause?: { message?: string } }).cause;
      throw cause?.message ? Object.assign(new Error(`${(e as Error).message}: ${cause.message}`), { cause }) : e;
    }
  }) as unknown as typeof fetch;
}
