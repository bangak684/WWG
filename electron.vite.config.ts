import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: 'src/main/index.ts' } } } },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { server: { host: '127.0.0.1' } }
});
