import { build } from "vite";

await build();
const server = await Bun.build({
  entrypoints: ["server/index.ts"],
  target: "bun",
  format: "esm",
  minify: true,
  sourcemap: "none",
  outdir: "build",
  naming: "server.js",
});
if (!server.success) {
  for (const message of server.logs) console.error(message);
  process.exit(1);
}
console.log("Built the web interface and the dependency-free Bun server.");
