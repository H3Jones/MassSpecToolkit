import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  base: "/MassSpecToolkit/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "ms-toolkit/core": fileURLToPath(
        new URL("../../packages/ms-toolkit/src/core/index.ts", import.meta.url),
      ),
      "ms-toolkit/charts": fileURLToPath(
        new URL("../../packages/ms-toolkit/src/charts/index.ts", import.meta.url),
      ),
      "ms-toolkit/mass-spectrum": fileURLToPath(
        new URL("../../packages/ms-toolkit/src/elements/mass-spectrum.ts", import.meta.url),
      ),
      "ms-toolkit/table": fileURLToPath(
        new URL("../../packages/ms-toolkit/src/elements/table.ts", import.meta.url),
      ),
      "ms-toolkit/ion-calculator": fileURLToPath(
        new URL("../../packages/ms-toolkit/src/elements/ion-calculator.ts", import.meta.url),
      ),
      "ms-toolkit/mass-split": fileURLToPath(
        new URL("../../packages/ms-toolkit/src/elements/mass-split.ts", import.meta.url),
      ),
      "ms-toolkit/fine-isotope-structure": fileURLToPath(
        new URL(
          "../../packages/ms-toolkit/src/elements/fine-isotope-structure.ts",
          import.meta.url,
        ),
      ),
      "ms-toolkit/peak-assignment": fileURLToPath(
        new URL("../../packages/ms-toolkit/src/elements/peak-assignment.ts", import.meta.url),
      ),
    },
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
  worker: { format: "es" },
  test: { include: ["src/**/*.test.ts"] },
  fmt: {},
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
});
