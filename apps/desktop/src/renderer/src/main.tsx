import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

async function boot(): Promise<void> {
  // In a plain browser (Vite dev URL, no Electron preload) install the scripted preview bridge.
  if (import.meta.env.DEV && !window.agent2db) {
    const { installDevBridge } = await import('./devBridge');
    installDevBridge();
  }
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
