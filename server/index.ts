import { join } from "node:path";
import { createApplication } from "./app.ts";

process.umask(0o077);
const port = Number(process.env.PORT ?? 8080);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
const app = createApplication({
  databasePath: process.env.DATABASE_PATH ?? "/data/dyntick.sqlite",
  staticDirectory: process.env.STATIC_DIRECTORY ?? join(import.meta.dir, "site"),
});
const server = Bun.serve({
  hostname: "0.0.0.0", port, fetch: app.fetch, maxRequestBodySize: 2 * 1024 * 1024,
});
console.log(`Dyntick is ready on port ${server.port}.`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  app.close();
  process.exit(0);
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
