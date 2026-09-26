import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  assetsInclude: ['**/*.glb', '**/*.hdr', '**/*.ktx2', '**/*.exr'],
});
