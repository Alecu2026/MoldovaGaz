"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SeenRow } from "@/lib/services/integration";
import type { SeenPage } from "@/lib/services/seen";
import ExpandButton, { useExpand } from "./Expand";
import Widget from "./Widget";

/**
 * „De la care contoare vin datele”: TOATE contoarele care au trimis prin integrare, ca fereastră derulantă (în DOM doar rândurile vizibile, înălțime fixă),
 * pagini de 100 aduse la nevoie și reținute în memorie, căutare după nume cu așteptare de 350 ms. Cele mai recente primele.
 */
const ROW_H = 34;
const VIEW_H = 560;
const PAGE = 100;
const MAX_PAGES_KEPT = 60;
const MAX_ROWS = 500_000;

const nf = new Intl.NumberFormat("ro-RO");
const p2 = (n: number) => String(n).padStart(2, "0");
const when = (ms: number) => {
  if (!(ms > 0)) return "—";
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (r.status === 401) {
      window.location.replace("/login");
      return null;
    }
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function SeenList({ q, onTotal }: { q: string; onTotal: (n: number) => void }) {
  const pages = useRef(new Map<number, SeenRow[]>());
  const inflight = useRef(new Set<number>());
  const alive = useRef(true);
  const [pageMap, setPageMap] = useState<Map<number, SeenRow[]>>(() => new Map());
  const [total, setTotal] = useState<number | null>(null);
  const [top, setTop] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [vh, setVh] = useState(VIEW_H);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVh(el.clientHeight || VIEW_H));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback((p: number) => {
    if (pages.current.has(p) || inflight.current.has(p)) return;
    inflight.current.add(p);
    void getJson<SeenPage>(`/api/integration/devices?skip=${p * PAGE}&limit=${PAGE}&q=${encodeURIComponent(q)}`).then((j) => {
      inflight.current.delete(p);
      if (!alive.current || !j) return;
      pages.current.set(p, j.rows);
      if (pages.current.size > MAX_PAGES_KEPT) pages.current.delete(pages.current.keys().next().value as number);
      setPageMap(new Map(pages.current));
      setTotal(j.total);
      onTotal(j.total);
    });
  }, [q, onTotal]);

  const count = Math.min(MAX_ROWS, total ?? PAGE);
  const first = Math.max(0, Math.floor(top / ROW_H) - 3);
  const last = Math.min(count, Math.ceil((top + vh) / ROW_H) + 3);
  const p0 = Math.floor(first / PAGE), p1 = Math.floor(Math.max(first, last - 1) / PAGE);
  useEffect(() => {
    for (let p = p0; p <= p1; p++) load(p);
  }, [p0, p1, load]);

  const out: React.ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const row = pageMap.get(Math.floor(i / PAGE))?.[i % PAGE];
    out.push(
      row ? (
        <div key={row.id} className="seen-row" role="row" style={{ top: i * ROW_H, height: ROW_H }}>
          <span className="mono">{row.name || row.id}</span>
          <span>{row.branch ?? "—"}</span>
          <span className="mono seen-num">{nf.format(row.n)}</span>
          <span className="mono">{when(row.last)}</span>
        </div>
      ) : (
        <div key={`s${i}`} className="seen-row" role="row" aria-hidden="true" style={{ top: i * ROW_H, height: ROW_H }}>
          <span className="skeleton" style={{ height: 10, width: "70%" }} />
        </div>
      ),
    );
  }
  return (
    <div className="kept-wrap" role="table" aria-label="Contoare care trimit" aria-rowcount={count + 1}>
      <div className="seen-head" role="row"><span>Contor</span><span>Filială</span><span className="seen-num">Mesaje</span><span>Ultimul mesaj</span></div>
      <div ref={box} className="kept-vp" onScroll={(e) => setTop((e.currentTarget as HTMLDivElement).scrollTop)}>
        <div style={{ height: count * ROW_H, position: "relative" }}>{out}</div>
        {total === 0 && <div className="cell-sub" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>{q ? "Niciun contor pentru această căutare." : "Niciun contor nu a trimis încă date aplicate pe contoare."}</div>}
      </div>
    </div>
  );
}

export default function SeenBrowser() {
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [full, setFull] = useExpand();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onQ = (v: string) => {
    setQInput(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQ(v.trim()), 350);
  };
  return (
    <Widget id="seen" defaultH={680} expanded={full} ariaLabel="Contoare care trimit">
      <header className="card-h">
        <div>
          <h3>De la care contoare vin datele</h3>
          <p>{total === null ? "se încarcă…" : `${nf.format(total)} contoare au trimis prin integrare${q ? " (cu căutarea aleasă)" : ""} · cele mai recente primele`}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input className="input" type="search" placeholder="caută contor" aria-label="Caută contor" value={qInput} onChange={(e) => onQ(e.target.value)} style={{ height: 34, width: 240 }} />
          <ExpandButton open={full} onToggle={() => setFull(!full)} />
        </div>
      </header>
      <SeenList key={q} q={q} onTotal={setTotal} />
    </Widget>
  );
}
