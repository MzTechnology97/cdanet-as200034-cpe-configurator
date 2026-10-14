import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Badge, Card, EmptyState, Notice, PageHeader, Skeleton } from '../ui';

/** Template disponibili (installers): the airOS templates this account may use in the app, by model. */

interface Template {
  id: number;
  model: string;
  name: string;
  isDefault?: boolean;
  personal?: boolean;
}

export function MyTemplates() {
  const q = useQuery({ queryKey: ['provisioning', 'templates'], queryFn: () => api<Template[]>('/api/provisioning/templates') });
  const list = q.data ?? [];
  const models = [...new Set(list.map((t) => t.model))];
  return (
    <div className="ui-page">
      <PageHeader icon="memory" title="Template disponibili" subtitle="I template airOS che puoi usare nell’app. Quello indicato come predefinito viene proposto automaticamente." />
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !q.data ? (
        <Skeleton lines={4} />
      ) : !list.length ? (
        <Card>
          <EmptyState icon="memory" title="Nessun template disponibile">
            Contatta un amministratore per abilitarne uno sul tuo account.
          </EmptyState>
        </Card>
      ) : (
        <div className="ui-grid-2">
          {models.map((m) => (
            <Card key={m} title={m} padded={false}>
              <ul className="hl-list">
                {list
                  .filter((t) => t.model === m)
                  .map((t) => (
                    <li key={t.id ?? t.name} className="hl-row">
                      <div className="hl-main">
                        <div className="hl-name">
                          <strong>{t.name}</strong>
                          {t.isDefault && <Badge tone="good">predefinito per te</Badge>}
                          {t.personal ? <Badge tone="warn">riservato</Badge> : <Badge>tutti</Badge>}
                        </div>
                      </div>
                    </li>
                  ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
