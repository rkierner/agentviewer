import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const COLLECTOR = `http://127.0.0.1:${process.env.AGENTVIEWER_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: COLLECTOR, changeOrigin: false } },
  },
});
