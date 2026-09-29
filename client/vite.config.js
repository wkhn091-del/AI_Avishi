import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the UI runs on Vite (http://localhost:5173) and every /api
// request is proxied to the Express server, so the browser only ever talks to
// one origin. The Host header is passed through unchanged, which is what the
// server's DNS-rebinding guard expects.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:4000' },
    },
  },
});
