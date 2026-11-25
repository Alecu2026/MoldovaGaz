"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Jurnalul de audit, partea din browser: trimite (în grupuri mici, la câteva secunde) fiecare pagină deschisă, cât timp a stat utilizatorul pe ea,
 * filtrele / vederea schimbate din adresă și clicurile pe butoane, linkuri și file. Nu citește conținutul câmpurilor (parole, text scris).
 * Nu desenează nimic și nu încetinește pagina: evenimentele merg cu sendBeacon, la repaus.
 */
type Fields = { t: string; p: string; [k: string]: unknown };
type Ev = Fields & { at: number };
const ENDPOINT = "/api/audit/navigare";
const FLUSH_MS = 4000;
const MAX_QUEUE = 120;

const g = globalThis as unknown as { __trackQ?: Ev[]; __trackTimer?: ReturnType<typeof setTimeout> | null };

function send(batch: Ev[]): void {
  if (batch.length === 0) return;
  const now = Date.now();
  const body = JSON.stringify({ events: batch.map((e) => { const { at, ...rest } = e; return { ...rest, ago: now - at }; }) });
  try {
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
  } catch { /* se încearcă fetch */ }
  void fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => undefined);
}
function flush(): void {
  if (g.__trackTimer) { clearTimeout(g.__trackTimer); g.__trackTimer = null; }
  const q = g.__trackQ ?? [];
  g.__trackQ = [];
  for (let i = 0; i < q.length; i += 40) send(q.slice(i, i + 40));
}
function push(e: Fields): void {
  const q = (g.__trackQ ??= []);
  if (q.length >= MAX_QUEUE) q.shift();
  q.push({ ...e, at: Date.now() });
  if (!g.__trackTimer) g.__trackTimer = setTimeout(flush, FLUSH_MS);
}

const navType = (): string => {
  try {
    const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return n?.type === "reload" ? "reload" : n?.type === "back_forward" ? "back" : "load";
  } catch { return "load"; }
};

/** textul vizibil al elementului apăsat: buton, link, filă, element de meniu (fără câmpuri de text) */
function labelOf(el: Element): { x: string; k: string; h: string } | null {
  const t = el.closest("button, a, [role='tab'], [role='menuitem'], summary, [role='button']") as HTMLElement | null;
  if (!t) return null;
  if (t.closest("[data-no-track]")) return null;
  const txt = (t.getAttribute("aria-label") || t.innerText || t.textContent || t.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const tag = t.getAttribute("role") || t.tagName.toLowerCase();
  let h = "";
  if (t instanceof HTMLAnchorElement) { try { const u = new URL(t.href, location.href); h = u.origin === location.origin ? u.pathname + (u.search ? "?…" : "") : u.origin; } catch { /* adresă invalidă */ } }
  return { x: txt, k: tag, h };
}

export default function AuditTracker() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const cur = useRef<{ p: string; q: string; start: number; since: number; shown: number; vis: boolean } | null>(null);
  const prev = useRef<string | null>(null);
  const first = useRef(true);
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeCurrent = (why: string) => {
    const c = cur.current;
    if (!c) return;
    const now = Date.now();
    const shown = c.shown + (c.vis ? now - c.since : 0);
    push({ t: "leave", p: c.p, s: Math.round(shown / 1000), w: Math.round((now - c.start) / 1000), why });
    cur.current = null;
  };

  // pagină nouă ⇒ încheie pagina veche (timp petrecut) și deschide una nouă
  useEffect(() => {
    if (cur.current?.p === pathname) return; // dublura din modul de dezvoltare (Strict Mode)
    closeCurrent("nav");
    const isFirst = first.current;
    first.current = false;
    const device = isFirst
      ? { sw: screen.width, sh: screen.height, vw: innerWidth, vh: innerHeight, dpr: Math.round(devicePixelRatio * 10) / 10, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, conn: (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType ?? "" }
      : undefined;
    push({ t: "view", p: pathname, q: search, ti: document.title, ref: prev.current ?? (document.referrer && new URL(document.referrer).origin === location.origin ? new URL(document.referrer).pathname : ""), nav: isFirst ? navType() : "app", dev: device });
    cur.current = { p: pathname, q: search, start: Date.now(), since: Date.now(), shown: 0, vis: document.visibilityState === "visible" };
    prev.current = pathname;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doar la schimbarea paginii
  }, [pathname]);

  // aceeași pagină, alte filtre / altă filă (adresa se schimbă fără navigare): un eveniment, după ce se liniștește
  useEffect(() => {
    const c = cur.current;
    if (!c || c.q === search) return;
    const before = c.q;
    c.q = search;
    if (queryTimer.current) clearTimeout(queryTimer.current);
    queryTimer.current = setTimeout(() => push({ t: "query", p: c.p, q: search, pq: before }), 1500);
    return () => { if (queryTimer.current) clearTimeout(queryTimer.current); };
  }, [search]);

  // timp cu pagina vizibilă + închiderea filei + clicuri
  useEffect(() => {
    const onVis = () => {
      const c = cur.current;
      if (!c) return;
      const now = Date.now();
      if (document.visibilityState === "hidden") {
        if (c.vis) c.shown += now - c.since;
        c.vis = false;
        flush();
      } else { c.vis = true; c.since = now; }
    };
    const onHide = () => { closeCurrent("exit"); flush(); };
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      const l = labelOf(e.target);
      if (l && cur.current) push({ t: "click", p: cur.current.p, ...l });
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("click", onClick, { capture: true });
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("click", onClick, { capture: true });
    };
  }, []);

  return null;
}
