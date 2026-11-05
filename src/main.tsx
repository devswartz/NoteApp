import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initPlatform, installExternalLinkHandler } from './platform/index.ts';
import './styles.css';

void initPlatform().then(() => {
  installExternalLinkHandler();
  createRoot(document.getElementById('root')!).render(<App />);
});
