/**
 * Live updates of the console (Server-Sent Events on /api/events): a topic says that something
 * changed, never what; the page asks the API again, with the rights of its user. So an event
 * carries no data and cannot leak any: an installer told "outages changed" sees only their zones.
 */
export type LiveTopic = 'notifications' | 'advisor' | 'outages';

/** Who hears it: every admin, everyone logged in, or these users. */
export type LiveAudience = 'admins' | 'all' | number[];

interface Client {
  userId: number;
  admin: boolean;
  send: (topic: LiveTopic) => void;
}

export function createLive() {
  const clients = new Set<Client>();
  return {
    subscribe(c: Client): () => void {
      clients.add(c);
      return () => clients.delete(c);
    },
    publish(topic: LiveTopic, to: LiveAudience) {
      for (const c of clients) {
        if (to === 'all' || (to === 'admins' ? c.admin : to.includes(c.userId))) {
          try {
            c.send(topic);
          } catch {
            /* a closed stream goes away on its own close event */
          }
        }
      }
    },
    /** Open streams (for the health of the server). */
    count: () => clients.size,
  };
}
export type Live = ReturnType<typeof createLive>;
