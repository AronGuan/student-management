import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The two ports are declared once here and read by both the dev server and the
// preview server (the deploy scripts read the same numbers from the shell).
// They are deliberately in the 19xxx band: 8080 / 5173 collide with other
// services on a shared box, and 3000 / 8000 / 9000 / 9090 are common enough
// that they are not worth the gamble either.
const FE_PORT = Number(process.env.FRONTEND_PORT ?? 19073);
const BE_PORT = Number(process.env.BACKEND_PORT ?? 19080);

// Backend base URL. The app always talks to /api on its own origin so the
// httpOnly `ae_token` cookie stays same-origin (see docs/ARCHITECTURE.md §auth).
//
// The preview server needs this proxy as much as the dev server does: it serves
// the built bundle, and without a proxy the browser would request /api on the
// preview origin and be handed the SPA's index.html with a 200 - a failure that
// looks like "the API returned HTML" rather than "nothing is proxying".
const proxy = {
  '/api': {
    target: process.env.VITE_PROXY_TARGET ?? `http://127.0.0.1:${BE_PORT}`,
    changeOrigin: true,
  },
};

// strictPort on purpose: if the port is taken, fail loudly instead of drifting
// to the next free one. A drifted port is invisible to the security group and
// to whatever the proxy target says, so the service looks up while nothing
// reachable is listening where we claimed it was.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: FE_PORT,
    strictPort: true,
    proxy,
  },
  // Preview is how this app is served on the server (scripts/start-frontend.sh).
  // host: true binds 0.0.0.0 - dev stays on localhost, this one must be reachable.
  preview: {
    port: FE_PORT,
    strictPort: true,
    host: true,
    proxy,
  },
});
