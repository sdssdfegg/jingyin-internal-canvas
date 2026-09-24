import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number.parseInt(process.env.PORT || "8787", 10);
const hmrPort = Number.parseInt(process.env.VITE_HMR_PORT || String(port + 100), 10);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port,
    watch: {
      ignored: ["**/.secure-build/**", "**/.release-temp/**", "**/dist/**"]
    },
    ...(Number.isFinite(hmrPort) ? { hmr: { host: "127.0.0.1", port: hmrPort } } : {})
  }
});
