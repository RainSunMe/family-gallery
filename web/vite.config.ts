import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: false } },
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
