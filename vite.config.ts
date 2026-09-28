import { defineConfig, type Plugin } from 'vite';

// Plausible (self-hosted), production build only: the dev server (5173) and the no-HMR capture server
// (tools/audio/vite.audio.config.ts, 5199) drive headless video / audio captures, which must not load
// third-party scripts or send pageviews.
const PLAUSIBLE = `    <!-- Privacy-friendly analytics by Plausible -->
    <script async src="https://analytics.tools.boldmove.cz/js/pa-2CQAGPOBuZ9lvTwQmkw5D.js"></script>
    <script>
      window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
      plausible.init()
    </script>
`;

const analytics = (): Plugin => ({
  name: 'plausible-analytics',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(/\n\s*<\/head>/, `\n${PLAUSIBLE}  </head>`),
});

export default defineConfig({
  plugins: [analytics()],
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  assetsInclude: ['**/*.glb', '**/*.hdr', '**/*.ktx2', '**/*.exr'],
});
