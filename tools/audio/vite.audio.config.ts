// Private dev server for audio captures (no HMR / file watching, so other areas' edits do not
// reload the page mid-recording):  npx vite --config tools/audio/vite.audio.config.ts
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../../vite.config';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  ...base,
  root,
  server: { host: '127.0.0.1', port: 5199, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
});
