"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { playAlert, registerSw, soundEnabled, unlockAudio } from "./notify-client";

/**
 * Clopoțelul din meniu (doar pentru cine primește notificări): arată câte probleme noi sunt și, când apare una nouă cât timp aplicația e deschisă, redă sunetul.
 * Înregistrează și service worker-ul (necesar pentru notificările push) și „deblochează” sunetul la prima atingere.
 */
export default function NotifBell() {
  const [unread, setUnread] = useState<number | null>(null);
  const last = useRef<number | null>(null);
  useEffect(() => {
    void registerSw();
    const un = () => unlockAudio();
    window.addEventListener("pointerdown", un, { once: true });
    window.addEventListener("keydown", un, { once: true });
    let dead = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/notifications", { cache: "no-store" });
        if (!r.ok || dead) return;
        const j = (await r.json()) as { unread: number };
        if (last.current !== null && j.unread > last.current && soundEnabled() && document.visibilityState === "visible") playAlert("warn");
        last.current = j.unread; setUnread(j.unread);
      } catch { /* la următoarea citire */ }
    };
    const t0 = setTimeout(() => void poll(), 0);
    const iv = setInterval(() => void poll(), 45_000);
    const vis = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", vis);
    // un push sosit cât aplicația e deschisă: sunet imediat + citire
    const onMsg = (e: MessageEvent) => { if ((e.data as { type?: string } | null)?.type === "push") { if (soundEnabled()) playAlert((e.data as { level?: "warn" | "crit" }).level ?? "warn"); void poll(); } };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => { dead = true; clearTimeout(t0); clearInterval(iv); document.removeEventListener("visibilitychange", vis); navigator.serviceWorker?.removeEventListener("message", onMsg); window.removeEventListener("pointerdown", un); window.removeEventListener("keydown", un); };
  }, []);
  return (
    <Link href="/notificari" className="bell" title="Notificări" aria-label={unread ? `Notificări: ${unread} noi` : "Notificări"}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2Zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2Z" /></svg>
      <span>Notificări</span>
      {unread ? <b className="bell-n">{unread > 99 ? "99+" : unread}</b> : null}
    </Link>
  );
}
