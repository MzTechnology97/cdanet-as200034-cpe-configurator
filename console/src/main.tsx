// The console: the new frame (React) with the pages of web/js inside it, converted one at a time
// (docs: "Piano nuovo frontend React CDA Net"). Style: the pages' stylesheet, then the tokens and
// the components of the new design system.
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../web/css/app.css';
import './styles/tokens.css';
import './styles/ui.css';
import './styles/shell.css';
import { App } from './shell/App';
import { applyTheme } from './shell/theme';
import { queryClient } from './lib/query';

applyTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
