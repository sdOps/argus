import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev server proxies /api and /ws to argus-server. Natively that's 127.0.0.1:3000;
// under Docker Compose the UI container reaches the server by its compose DNS name, so
// ARGUS_SERVER_URL is set to http://argus-server:3000 and VITE_HOST to 0.0.0.0.
const SERVER_URL = process.env.ARGUS_SERVER_URL || "http://127.0.0.1:3000";
const WS_URL = SERVER_URL.replace(/^http/, "ws");
const HOST = process.env.VITE_HOST || "127.0.0.1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: HOST,
    port: 5173,
    proxy: {
      "/ws": {
        target: WS_URL,
        ws: true,
      },
      "/api": {
        target: SERVER_URL,
      },
    },
  },
});
