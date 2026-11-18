import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { parseActivity } from "../src/activity.ts";
import type { Action } from "../src/protocol.ts";
import { isLanguage, MAX_CYCLE_SESSIONS, MODES, type Preferences } from "../src/timer.ts";
import { StateConflict, StudyDatabase } from "./db.ts";

const MAX_BODY = 2 * 1024 * 1024;
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new HttpError(400, "invalid_request");
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new HttpError(400, "invalid_request_id");
}
function integer(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function actionFrom(value: unknown): Action {
  if (!object(value)) throw new HttpError(400, "invalid_action");
  if (value.type === "start" || value.type === "pause" || value.type === "reset") {
    only(value, ["type"]);
    return { type: value.type };
  }
  if (value.type === "mode") {
    only(value, ["type", "mode"]);
    if (!MODES.includes(value.mode as typeof MODES[number])) throw new HttpError(400, "invalid_mode");
    return { type: "mode", mode: value.mode as typeof MODES[number] };
  }
  if (value.type === "preferences" && object(value.patch)) {
    only(value, ["type", "patch"]);
    const patch = value.patch;
    only(patch, ["focusMinutes", "shortBreakMinutes", "longBreakMinutes", "longBreakInterval", "soundEnabled", "theme", "language"]);
    for (const [key, next] of Object.entries(patch)) {
      const valid = key === "longBreakInterval" ? integer(next, 1, MAX_CYCLE_SESSIONS)
        : key === "soundEnabled" ? typeof next === "boolean"
        : key === "theme" ? next === "system" || next === "light" || next === "dark"
        : key === "language" ? isLanguage(next)
        : integer(next, 1, 180);
      if (!valid) throw new HttpError(400, "invalid_preferences");
    }
    return { type: "preferences", patch: patch as Partial<Preferences> };
  }
  throw new HttpError(400, "invalid_action");
}

async function bodyFrom(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > MAX_BODY) throw new HttpError(413, "request_too_large");
  // Stream the limit as well: a chunked request must not bypass Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new HttpError(413, "request_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!object(parsed)) throw new Error("Expected an object");
    return parsed;
  } catch { throw new HttpError(400, "invalid_json"); }
}

function checkWrite(request: Request, url: URL) {
  if (request.headers.get("X-Dyntick-Request") !== "1") throw new HttpError(403, "application_header_required");
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "json_required");
  }
  const origin = request.headers.get("Origin");
  // A TLS-terminating reverse proxy may forward HTTPS to the HTTP container.
  const forwardedProtocol = request.headers.get("X-Forwarded-Proto");
  const publicOrigin = forwardedProtocol === "https" ? `https://${url.host}` : url.origin;
  if (origin && origin !== publicOrigin) throw new HttpError(403, "origin_rejected");
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") throw new HttpError(403, "origin_rejected");
}

export interface ApplicationOptions {
  databasePath: string;
  staticDirectory?: string;
  now?: () => number;
}

export function createApplication(options: ApplicationOptions) {
  const database = new StudyDatabase(options.databasePath, options.now);
  const directory = options.staticDirectory ? realpathSync(options.staticDirectory) : null;
  const cache = new Map<string, { data: Uint8Array<ArrayBuffer>; gzip: Uint8Array<ArrayBuffer> | null; type: string }>();
  const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(value, { status, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...extra } });

  return {
    close: () => database.close(),
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
          if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
          database.health();
          return new Response(request.method === "HEAD" ? null : "ok\n", {
            headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        if (url.pathname === "/api/state") {
          if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
          return json(database.read());
        }
        if (url.pathname === "/api/action" || url.pathname === "/api/import") {
          if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
          checkWrite(request, url);
          const body = await bodyFrom(request);
          id(body.requestId);
          // Bind browser retries to this database, including after a volume was replaced.
          if (body.instanceId !== undefined) {
            id(body.instanceId);
            const state = database.read();
            if (body.instanceId !== state.instanceId) throw new StateConflict(state, "instance_changed");
          }
          if (url.pathname === "/api/action") {
            only(body, ["requestId", "instanceId", "revision", "action"]);
            if (!integer(body.revision, 0, Number.MAX_SAFE_INTEGER)) throw new HttpError(400, "invalid_revision");
            return json(database.action(body.requestId, body.revision as number, actionFrom(body.action)));
          }
          only(body, ["requestId", "instanceId", "preferences", "timer", "activity"]);
          if (body.preferences !== undefined && !object(body.preferences) ||
            body.timer !== undefined && !object(body.timer) || body.activity !== undefined && !object(body.activity)) {
            throw new HttpError(400, "invalid_import");
          }
          return json(database.importLegacy(body.requestId, {
            preferences: body.preferences, timer: body.timer,
            activity: parseActivity(body.activity ? JSON.stringify(body.activity) : null),
          }));
        }
        if (url.pathname.startsWith("/api/") || url.pathname === "/api") throw new HttpError(404, "not_found");
        if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
        if (!directory) throw new HttpError(404, "not_found");
        let pathname: string;
        try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(404, "not_found"); }
        if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some((part) => part.startsWith("."))) {
          throw new HttpError(404, "not_found");
        }
        const filename = pathname === "/" ? "index.html" : pathname.slice(1);
        if (!CONTENT_TYPES[extname(filename)]) throw new HttpError(404, "not_found");
        let asset = cache.get(filename);
        if (!asset) {
          try {
            const path = realpathSync(resolve(directory, filename));
            const inside = relative(directory, path);
            if (!inside || inside.startsWith("..") || !statSync(path).isFile()) throw new Error("Outside static assets");
            const data = new Uint8Array(readFileSync(path));
            const type = CONTENT_TYPES[extname(filename)];
            const gzip = data.byteLength >= 1024 && data.byteLength <= 4 * 1024 * 1024 && !filename.endsWith(".woff2")
              ? new Uint8Array(Bun.gzipSync(data)) : null;
            asset = { data, gzip, type };
            cache.set(filename, asset);
          } catch { throw new HttpError(404, "not_found"); }
        }
        const gzipAccepted = /(?:^|,)\s*gzip\s*(?:;\s*q\s*=\s*(?!0(?:\.0*)?(?:\s|,|$))[0-9.]+)?\s*(?:,|$)/i.test(request.headers.get("Accept-Encoding") ?? "");
        const compressed = Boolean(asset.gzip && gzipAccepted);
        const data = compressed ? asset.gzip! : asset.data;
        return new Response(request.method === "HEAD" ? null : data, {
          headers: { ...SECURITY_HEADERS, "Content-Type": asset.type,
            "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
            "Content-Length": String(data.byteLength), Vary: "Accept-Encoding",
            ...(compressed ? { "Content-Encoding": "gzip" } : {}),
          },
        });
      } catch (error) {
        if (error instanceof StateConflict) return json({ error: error.code, state: error.state }, 409);
        if (error instanceof HttpError) return json({ error: error.code }, error.status);
        console.error("Dyntick could not complete a database or HTTP operation.");
        return json({ error: "storage_unavailable" }, 503);
      }
    },
  };
}
