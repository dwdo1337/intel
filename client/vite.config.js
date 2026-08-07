import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// host is pinned to 127.0.0.1 deliberately. Vite's default binding came up
// IPv6-only ([::1]) on this machine, so http://127.0.0.1:5173 refused
// connections while http://[::1]:5173 worked. Electron/Chromium resolving
// "localhost" to IPv4 first then hits a closed port and renders a blank
// window with no visible error -- which is exactly the dev-mode blank
// screen this project kept hitting. Pinning both ends to 127.0.0.1 removes
// the resolution ambiguity entirely. (See electron/main.cjs, which loads
// http://127.0.0.1:5173 to match.)
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5050',
      '/socket.io': { target: 'http://127.0.0.1:5050', ws: true },
    },
  },
});
