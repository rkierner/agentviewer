import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { ensureToken } from './hooks/token.mjs';

const COLLECTOR = `http://127.0.0.1:${process.env.AGENTVIEWER_PORT ?? 4317}`;

/** Print the one link that unlocks the UI, using the port Vite actually got. */
function accessLink(): Plugin {
  return {
    name: 'agentviewer-access-link',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address();
        if (!address || typeof address === 'string') return;
        setTimeout(() => console.log(`\n  ▌Open Agent Matrix: http://127.0.0.1:${address.port}/#token=${ensureToken()}\n`), 50);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), accessLink()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: COLLECTOR, changeOrigin: false } },
  },
});
