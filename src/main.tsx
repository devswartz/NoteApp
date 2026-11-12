import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initPlatform, installExternalLinkHandler } from './platform/index.ts';
import { ErrorBoundary, installGlobalErrorHandlers } from './components/ErrorBoundary.tsx';
import { installErrorReporting } from './lib/errorReporting.ts';
import { installFileLinkRetry } from './lib/fileLinkRetry.ts';
import './styles.css';

installErrorReporting(); // before anything else can fail; reports go to POST /api/client-errors

void initPlatform().then(() => {
  installExternalLinkHandler();
  installGlobalErrorHandlers();
  installFileLinkRetry();
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary page>
      <App />
    </ErrorBoundary>,
  );
});
