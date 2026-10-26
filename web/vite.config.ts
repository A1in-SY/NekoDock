import { defineConfig } from "vite";
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 4178,
    proxy: { "/api": "http://127.0.0.1:4180" },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
