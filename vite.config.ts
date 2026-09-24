import { defineConfig } from "vite";
import { ledgerApiPlugin } from "./src/server/vite-plugin.ts";

export default defineConfig({
  plugins: [ledgerApiPlugin()],
  server: { host: "127.0.0.1", port: 5356, strictPort: true }
});
