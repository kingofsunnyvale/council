import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export default defineConfig(({ command }) => {
  const local = command === 'serve' && existsSync('.dev.vars') ? parseEnv(readFileSync('.dev.vars','utf8')) : {};
  return { plugins: [react()], server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8787', headers: { 'x-council-service': local.SERVICE_SECRET || '' } } } }, build: { sourcemap: false } };
});
