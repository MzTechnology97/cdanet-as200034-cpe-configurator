import { adminGuideBody } from '../../../web/js/views/guide.js';
import { Card, Dom, PageHeader } from '../ui';

/**
 * Guida amministratore: the server's own guide (admin-only route, no device or user data), with
 * its index and the photo viewer of web/js; the installers' guide is the public wiki.
 */
export function Guide() {
  return (
    <div className="ui-page">
      <PageHeader
        icon="menu_book"
        title="Guida amministratore"
        subtitle="Come preparare il sistema, gestire installatori e rete. Visibile solo agli amministratori."
        actions={
          <a className="ui-btn ui-btn-secondary" href="/wiki/" target="_blank" rel="noopener">
            Guida installatore
          </a>
        }
      />
      <Card>
        <Dom make={() => adminGuideBody()} />
      </Card>
    </div>
  );
}
