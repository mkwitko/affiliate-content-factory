import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    // The Cloudflare worker inlines dist/assets as UTF-8 text, so binary fonts ride inside the CSS.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? true : undefined),
  },
});
