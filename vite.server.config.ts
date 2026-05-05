import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: resolve(__dirname, 'src/server/index.ts'),
    outDir: resolve(__dirname, 'dist/server'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      output: {
        entryFileNames: 'index.js'
      },
      external: ['better-sqlite3', 'imapflow', 'mailparser']
    }
  }
});
