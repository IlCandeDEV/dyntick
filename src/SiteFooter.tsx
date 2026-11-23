import { useEffect, useState } from "react";
import { Icon } from "./Icons.tsx";
import type { Messages } from "./i18n.ts";

export function SiteFooter({ copy }: { copy: Messages }) {
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/latest-release", { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as { version: string | null };
        if (!controller.signal.aborted && typeof data.version === "string") setLatest(data.version);
      } catch { /* The installed version stays available offline. */ }
    };
    void refresh();
    const interval = setInterval(refresh, 15 * 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return <footer className="site-footer">
    <span>{copy.studentFooter}</span>
    <div className="site-footer-versions">
      <span>{copy.currentBuild} <strong className="site-footer-current">v{import.meta.env.DYNTICK_VERSION}</strong></span>
      <span>{copy.latestRelease} <strong className="site-footer-latest" title={latest ? undefined : copy.releaseUnavailable}>
        {latest ? `v${latest}` : "—"}
      </strong></span>
    </div>
    <a href="https://github.com/IlCandeDEV/dyntick" target="_blank" rel="noopener noreferrer">
      GitHub<Icon name="arrow" width="15" height="15" />
    </a>
  </footer>;
}
