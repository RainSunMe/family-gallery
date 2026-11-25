import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    // Dev server runs on 5173 while the backend only trusts its own
    // APP_PUBLIC_URL, so every non-GET request from this origin would be
    // rejected with ORIGIN_REJECTED. Rewriting the Origin here keeps that check
    // intact in the server and confines the dev-only adjustment to this file.
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
        headers: { Origin: 'http://localhost:8080' },
      },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        entryFileNames: `assets/app-${Date.now()}.js`,
        chunkFileNames: `assets/chunk-${Date.now()}-[hash].js`,
        assetFileNames: `assets/app-${Date.now()}-[hash][extname]`,
      },
    },
  },
});
