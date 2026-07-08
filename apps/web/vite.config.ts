import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Dev-Proxy-Ziel per Env übersteuerbar (z. B. VITE_PROXY_TARGET=http://100.72.94.1:3010
// für lokale UI-Arbeit gegen den Live-Server). Default bleibt localhost.
const target = process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:3010';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': target,
      '/health': target,
    },
  },
});
