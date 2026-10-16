import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  base: "./",
  worker: { format: "es" },
  build: {
    outDir: "dist/browser",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        "ion-calculator": src("elements/ion-calculator.ts"),
        "mass-split": src("elements/mass-split.ts"),
      },
      output: {
        entryFileNames: "[name].mjs",
        chunkFileNames: "assets/[name]-[hash].mjs",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
