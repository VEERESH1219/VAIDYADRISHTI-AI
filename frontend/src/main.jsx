import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

// Error Overlay for Remote Debugging
window.onerror = (msg, url, line, col, error) => {
  const root = document.getElementById('root');
  if (root) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    root.innerHTML = `
      <div style="background: #1e1e1e; color: #ff5f56; padding: 20px; font-family: monospace; height: 100vh;">
        <h1 style="font-size: 1.5rem">🚨 Runtime Error</h1>
        <p>${esc(msg)}</p>
        <pre style="color: #ccc; background: #000; padding: 10px;">${esc(error?.stack || '')}</pre>
      </div>
    `;
  }
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
