// The console (React). Style: the base stylesheet (maps, tables, the pieces shared with the map of
// the app), then the tokens and the components of the design system.
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
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
