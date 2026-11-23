import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { parseActivity } from "../src/activity.ts";
import { EXAM_MONTHS, EXAM_SESSIONS, isCreditSystem, isDateFormat, isExamDate, isExamMonth, isExamSession, MAX_EXAM_CREDITS, MAX_EXAM_NAME_LENGTH, type ExamSession } from "../src/planning.ts";
import type { Action } from "../src/protocol.ts";
import { isLanguage, MAX_CYCLE_SESSIONS, MODES, type Preferences } from "../src/timer.ts";
import { StateConflict, StudyDatabase } from "./db.ts";
import { createLatestReleaseLookup, type ReleaseFetch } from "./releases.ts";

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

function examName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_EXAM_NAME_LENGTH) throw new HttpError(400, "invalid_exam_name");
  return name;
}

function examSession(value: unknown): ExamSession | null {
  if (value === null || isExamSession(value)) return value;
  throw new HttpError(400, "invalid_exam_session");
}

function examCredits(value: unknown): number {
  if (typeof value !== "number" || !integer(value, 0, MAX_EXAM_CREDITS)) throw new HttpError(400, "invalid_exam_credits");
  return value;
}

function examDate(value: unknown): string | null {
  if (value === null || isExamDate(value)) return value;
  throw new HttpError(400, "invalid_exam_date");
}

function examMonths(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > EXAM_MONTHS.length ||
      !value.every(isExamMonth) || new Set(value).size !== value.length) {
    throw new HttpError(400, "invalid_session_months");
  }
  return EXAM_MONTHS.filter((month) => value.includes(month));
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
  if (value.type === "exam.create" && object(value.exam)) {
    only(value, ["type", "exam"]);
    only(value.exam, ["id", "name", "academicYear", "session", "credits", "examDate"]);
    const { id: examId, name, academicYear, session } = value.exam;
    id(examId);
    if (typeof academicYear !== "number" || !integer(academicYear, 1000, 9998)) throw new HttpError(400, "invalid_academic_year");
    return { type: value.type, exam: { id: examId, name: examName(name), academicYear, session: examSession(session),
      ...("credits" in value.exam ? { credits: examCredits(value.exam.credits) } : {}),
      ...("examDate" in value.exam ? { examDate: examDate(value.exam.examDate) } : {}),
    } };
  }
  if (value.type === "exam.update" && object(value.patch)) {
    only(value, ["type", "id", "patch"]);
    only(value.patch, ["name", "session", "credits", "examDate"]);
    id(value.id);
    if (Object.keys(value.patch).length === 0) throw new HttpError(400, "invalid_action");
    return { type: value.type, id: value.id, patch: {
      ...("name" in value.patch ? { name: examName(value.patch.name) } : {}),
      ...("session" in value.patch ? { session: examSession(value.patch.session) } : {}),
      ...("credits" in value.patch ? { credits: examCredits(value.patch.credits) } : {}),
      ...("examDate" in value.patch ? { examDate: examDate(value.patch.examDate) } : {}),
    } };
  }
  if (value.type === "exam.delete") {
    only(value, ["type", "id"]);
    id(value.id);
    return { type: value.type, id: value.id };
  }
  if (value.type === "session.months") {
    only(value, ["type", "session", "months"]);
    const { session, months } = value;
    if (!isExamSession(session)) throw new HttpError(400, "invalid_exam_session");
    return { type: value.type, session, months: examMonths(months) };
  }
  if (value.type === "preferences" && object(value.patch)) {
    only(value, ["type", "patch", "sessionMonths"]);
    const patch = value.patch;
    only(patch, ["focusMinutes", "shortBreakMinutes", "longBreakMinutes", "longBreakInterval", "soundEnabled", "theme", "language", "creditSystem", "dateFormat"]);
    for (const [key, next] of Object.entries(patch)) {
      const valid = key === "longBreakInterval" ? integer(next, 1, MAX_CYCLE_SESSIONS)
        : key === "soundEnabled" ? typeof next === "boolean"
        : key === "theme" ? next === "system" || next === "light" || next === "dark"
        : key === "language" ? isLanguage(next)
        : key === "creditSystem" ? isCreditSystem(next)
        : key === "dateFormat" ? isDateFormat(next)
        : integer(next, 1, 180);
      if (!valid) throw new HttpError(400, "invalid_preferences");
    }
    const action: Extract<Action, { type: "preferences" }> = { type: "preferences", patch: patch as Partial<Preferences> };
    if ("sessionMonths" in value) {
      const months = value.sessionMonths;
      if (!object(months)) throw new HttpError(400, "invalid_session_months");
      only(months, EXAM_SESSIONS);
      action.sessionMonths = { winter: examMonths(months.winter), summer: examMonths(months.summer), resit: examMonths(months.resit) };
    }
    return action;
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
  fetchRelease?: ReleaseFetch;
}

export function createApplication(options: ApplicationOptions) {
  const database = new StudyDatabase(options.databasePath, options.now);
  const latestRelease = createLatestReleaseLookup(options.fetchRelease, options.now);
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
        if (url.pathname === "/api/latest-release") {
          if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
          return json({ version: await latestRelease() });
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
