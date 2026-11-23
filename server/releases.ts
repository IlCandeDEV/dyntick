const RELEASE_URL = "https://api.github.com/repos/IlCandeDEV/dyntick/releases/latest";
const CACHE_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;

export type ReleaseFetch = (url: string, init: RequestInit) => Promise<Response>;

export function createLatestReleaseLookup(fetchRelease: ReleaseFetch = fetch, now = Date.now) {
  let latest: string | null = null;
  let refreshAt = 0;
  let pending: Promise<string | null> | undefined;

  async function refresh() {
    let version: string | undefined;
    try {
      const response = await fetchRelease(RELEASE_URL, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Dyntick", "X-GitHub-Api-Version": "2026-03-10" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = await response.json() as { tag_name?: unknown } | null;
        if (typeof data?.tag_name === "string") version = /^v?(\d+\.\d+\.\d+)$/.exec(data.tag_name)?.[1];
      }
    } catch { /* A failed lookup can reuse the last successful result. */ }
    latest = version ?? latest;
    refreshAt = now() + (version ? CACHE_MS : RETRY_MS);
    return latest;
  }

  return () => {
    if (now() < refreshAt) return Promise.resolve(latest);
    return pending ??= refresh().finally(() => { pending = undefined; });
  };
}
