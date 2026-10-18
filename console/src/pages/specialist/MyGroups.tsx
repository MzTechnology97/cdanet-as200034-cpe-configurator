import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { myId } from './types';

interface Group {
  id: number;
  name: string;
  members: Array<{ id: number; username: string }>;
}

/**
 * The work groups of the specialist (issue #275): with whom he shares templates, installations and
 * calendar ([shared] says what this page shows of theirs). Nothing when he is in none. Connectors
 * and secrets are never shared.
 */
export function MyGroups({ shared }: { shared: string }) {
  const q = useQuery({ queryKey: ['specialist', 'work-groups'], queryFn: () => api<{ items: Group[] }>('/api/specialist/work-groups'), staleTime: 60_000, retry: false });
  const groups = q.data?.items ?? [];
  if (!groups.length) return null;
  const me = myId();
  return (
    <p className="ui-muted ui-small">
      {groups.map((g, i) => {
        const others = g.members.filter((m) => m.id !== me).map((m) => m.username);
        return (
          <span key={g.id}>
            {i > 0 ? ' · ' : ''}
            {groups.length > 1 ? 'Gruppi di lavoro: ' : 'Gruppo di lavoro '}
            <strong>{g.name}</strong>
            {others.length ? ` con ${others.join(', ')}` : ''}
          </span>
        );
      })}
      {`. Condividete ${shared}; connettori e segreti restano di ciascuno.`}
    </p>
  );
}
