import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3080",
        changeOrigin: true,
      },
      // The Rabble-hosted Slack MCP bridge lives on the API server too.
      "/mcp": {
        target: "http://localhost:3080",
        changeOrigin: true,
      },
    },
  },
});
