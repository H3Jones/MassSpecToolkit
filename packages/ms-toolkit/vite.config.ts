import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  fmt: {
    ignorePatterns: [],
  },
  base: "./",
  server: {
    fs: {
      allow: [fileURLToPath(new URL("../..", import.meta.url))],
    },
  },
  worker: { format: "es" },
  pack: {
    entry: {
      index: src("index.ts"),
      core: src("core/index.ts"),
      "ion-calculator": src("elements/ion-calculator.ts"),
      "mass-split": src("elements/mass-split.ts"),
      "mass-spectrum": src("elements/mass-spectrum.ts"),
      table: src("elements/table.ts"),
      charts: src("charts/index.ts"),
    },
    dts: true,
    format: ["esm"],
    target: "es2022",
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
  },
});
