import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Dev-only internal tool served through tunnels (Codespaces/Cloudflare),
    // so the Host header varies per tunnel — allow all rather than pinning.
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
