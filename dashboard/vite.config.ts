import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.CLAUDIA_LOCAL_PORT || 3939);

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // The server only answers its own Host/Origin, so the dev proxy presents itself as the app.
    proxy: {
      "/api": { target: `http://127.0.0.1:${port}`, changeOrigin: true, headers: { origin: `http://127.0.0.1:${port}` } },
      "/ws": { target: `ws://127.0.0.1:${port}`, ws: true, changeOrigin: true, headers: { origin: `http://127.0.0.1:${port}` } },
    },
  },
});
