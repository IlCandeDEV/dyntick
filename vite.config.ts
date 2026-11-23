import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  define: { "import.meta.env.DYNTICK_VERSION": JSON.stringify(process.env.DYNTICK_VERSION ?? version) },
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
