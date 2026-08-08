import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiProxy = { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:3000' };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
});
