import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/admin/',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: { outDir: '../gateway/dist/panel', emptyOutDir: true },
  server: { proxy: { '/admin/api': 'http://127.0.0.1:8787' } },
});
