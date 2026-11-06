// The web app: built into web/dist and served by the same Express server as the API, so the session cookie
// is same-origin. In dev, Vite proxies the API paths to the server on 4021.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const api = { target: "http://localhost:4021", changeOrigin: false };
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: { app: resolve(__dirname, "index.html") } } },
  server: { port: 5173, proxy: { "/api": api, "/proof": api, "/catalog": api, "/quote": api, "/queries": api } },
});
