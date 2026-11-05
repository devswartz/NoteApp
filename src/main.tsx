import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initPlatform, installExternalLinkHandler } from './platform/index.ts';
import { ErrorBoundary, installGlobalErrorHandlers } from './components/ErrorBoundary.tsx';
import './styles.css';

void initPlatform().then(() => {
  installExternalLinkHandler();
  installGlobalErrorHandlers();
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary page>
      <App />
    </ErrorBoundary>,
  );
});
