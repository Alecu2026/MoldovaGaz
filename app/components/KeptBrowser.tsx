"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeptDetail, KeptPage, KeptReason, KeptRow } from "@/lib/services/kept";
import ExpandButton, { useExpand } from "./Expand";
import Widget from "./Widget";

/**
 * „Toate datele păstrate” (pagina /integration): lista completă a mesajelor păstrate pentru procesare ulterioară, ca în restul aplicației:
 *  - FEREASTRĂ DERULANTĂ: în DOM sunt doar rândurile vizibile (înălțime fixă ⇒ poziția = index × înălțime), oricâte mesaje ar fi;
 *  - pagini de 100 de rânduri, aduse doar când ajung în fereastră, reținute în memorie (cache) cât timp filtrul rămâne același;
 *  - filtrul (motiv / text) schimbă cheia listei, deci pornește curat; căutarea așteaptă 350 ms după ultima tastă;
 *  - conținutul unui mesaj se aduce abia la click.
 * Curățarea reia mai întâi ce se potrivește acum cu un contor și șterge doar ce era păstrat înainte de apăsare.
 */
const ROW_H = 34;
const VIEW_H = 380;
const PAGE = 100;
const MAX_PAGES_KEPT = 60;
const MAX_ROWS = 500_000; // limita elementului derulant al browserului

const nf = new Intl.NumberFormat("ro-RO");
const p2 = (n: number) => String(n).padStart(2, "0");
const when = (ms: number) => {
  if (!(ms > 0)) return "—";
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const r = await fetch(url, { signal, cache: "no-store" });
    if (r.status === 401) {
      window.location.replace("/login");
      return null;
    }
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function KeptList({ reason, q, onTotal, onOpen, openId }: { reason: string; q: string; onTotal: (n: number) => void; onOpen: (id: string) => void; openId: string | null }) {
  const pages = useRef(new Map<number, KeptRow[]>());
  const inflight = useRef(new Set<number>());
  const alive = useRef(true);
  const [total, setTotal] = useState<number | null>(null);
  const [pageMap, setPageMap] = useState<Map<number, KeptRow[]>>(() => new Map());
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
    const url = `/api/integration/kept?skip=${p * PAGE}&limit=${PAGE}&reason=${encodeURIComponent(reason)}&q=${encodeURIComponent(q)}`;
    void getJson<KeptPage>(url).then((j) => {
      inflight.current.delete(p);
      if (!alive.current || !j) return;
      pages.current.set(p, j.rows);
      if (pages.current.size > MAX_PAGES_KEPT) pages.current.delete(pages.current.keys().next().value as number);
      setPageMap(new Map(pages.current));
      setTotal(j.total);
      onTotal(j.total);
    });
  }, [reason, q, onTotal]);

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
        <div key={row.id} className="kept-row" role="row" aria-selected={openId === row.id} style={{ top: i * ROW_H, height: ROW_H }} onClick={() => onOpen(row.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(row.id); }}>
          <span className="mono">{when(row.at)}</span>
          <span title={row.reason} className="kept-reason">{row.reason}</span>
          <span className="mono" title={row.dev}>{row.dev || "—"}</span>
          <span className="mono">{row.eui || "—"}</span>
          <span title={row.app}>{row.app || "—"}</span>
        </div>
      ) : (
        <div key={`s${i}`} className="kept-row" role="row" aria-hidden="true" style={{ top: i * ROW_H, height: ROW_H }}>
          <span className="skeleton" style={{ height: 10, width: "70%" }} />
        </div>
      ),
    );
  }

  return (
    <div className="kept-wrap" role="table" aria-label="Date păstrate" aria-rowcount={count + 1}>
      <div className="kept-head" role="row">
        <span>Ora</span><span>Motiv</span><span>Dispozitiv</span><span>devEUI</span><span>Aplicație</span>
      </div>
      <div ref={box} className="kept-vp" onScroll={(e) => setTop((e.currentTarget as HTMLDivElement).scrollTop)}>
        <div style={{ height: count * ROW_H, position: "relative" }}>{out}</div>
        {total === 0 && <div className="cell-sub" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>Nimic păstrat{reason || q ? " pentru acest filtru" : ""}.</div>}
      </div>
    </div>
  );
}

export default function KeptBrowser() {
  const [reasons, setReasons] = useState<KeptReason[]>([]);
  const [reason, setReason] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [version, setVersion] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KeptDetail | null>(null);
  const [panel, setPanel] = useState(false);
  const [full, setFull] = useExpand();
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadReasons = useCallback(() => {
    void getJson<{ reasons: KeptReason[] }>("/api/integration/kept?reasons=1").then((j) => { if (j) setReasons(j.reasons); });
  }, []);
  useEffect(() => {
    const t = setTimeout(loadReasons, 0);
    return () => clearTimeout(t);
  }, [loadReasons, version]);

  const onQ = (v: string) => {
    setQInput(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQ(v.trim()), 350);
  };
  const open = (id: string) => {
    setOpenId(id);
    setDetail(null);
    void getJson<KeptDetail>(`/api/integration/kept?id=${id}`).then((j) => setDetail(j));
  };
  const clean = async () => {
    setBusy(true);
    setDone(null);
    try {
      const r = await fetch("/api/integration/kept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear", reason: scope }) });
      const j = (await r.json()) as { reprocessed?: number; deleted?: number; remaining?: number; error?: string };
      setDone(r.ok ? `Șterse ${nf.format(j.deleted ?? 0)} · reluate și aplicate ${nf.format(j.reprocessed ?? 0)} · au rămas ${nf.format(j.remaining ?? 0)}.` : j.error ?? "Nu am putut curăța.");
      setPanel(false);
      setScope("");
      setOpenId(null);
      setDetail(null);
      setVersion((v) => v + 1);
    } catch {
      setDone("Nu am putut curăța.");
    } finally {
      setBusy(false);
    }
  };
  const scopeCount = scope ? reasons.find((r) => r.reason === scope)?.n ?? 0 : reasons.reduce((a, r) => a + r.n, 0);

  return (
    <Widget id="kept" defaultH={680} expanded={full} ariaLabel="Toate datele păstrate">
      <header className="card-h">
        <div>
          <h3>Toate datele păstrate</h3>
          <p>{total === null ? "se încarcă…" : `${nf.format(total)} mesaje${reason || q ? " (cu filtrul ales)" : ""} · cele mai noi primele; click pe un rând ca să vezi conținutul`}</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select className="select" aria-label="Motiv" value={reason} onChange={(e) => { setReason(e.target.value); setOpenId(null); setDetail(null); }} style={{ height: 34, maxWidth: 260 }}>
            <option value="">Toate motivele</option>
            {reasons.map((r) => <option key={r.reason} value={r.reason}>{r.reason.slice(0, 60)} ({nf.format(r.n)})</option>)}
          </select>
          <input className="input" type="search" placeholder="caută: dispozitiv, devEUI, aplicație" aria-label="Caută" value={qInput} onChange={(e) => onQ(e.target.value)} style={{ height: 34, width: 240 }} />
          <button type="button" className="btn" onClick={() => setVersion((v) => v + 1)}>Reîmprospătează</button>
          <button type="button" className="btn" onClick={() => { setPanel((p) => !p); setDone(null); }} aria-expanded={panel}>Curăță…</button>
          <ExpandButton open={full} onToggle={() => setFull(!full)} />
        </div>
      </header>

      {panel && (
        <div className="kept-clean" role="group" aria-label="Curățare">
          <label className="field" style={{ minWidth: 280 }}>
            <span>Ce se șterge</span>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Tot ce e păstrat ({nf.format(reasons.reduce((a, r) => a + r.n, 0))})</option>
              {reasons.map((r) => <option key={r.reason} value={r.reason}>Doar: {r.reason.slice(0, 70)} ({nf.format(r.n)})</option>)}
            </select>
          </label>
          <p className="cell-sub" style={{ margin: 0, whiteSpace: "normal", flex: 1, minWidth: 260 }}>
            Se vor șterge definitiv până la {nf.format(scopeCount)} mesaje. Înainte se reiau și se aplică cele care se potrivesc acum cu un contor; se șterge doar restul. Mesajele care sosesc între timp nu se ating.
          </p>
          <button type="button" className="btn btn-primary" disabled={busy || scopeCount === 0} onClick={() => { if (window.confirm(`Ștergi definitiv până la ${nf.format(scopeCount)} mesaje păstrate?`)) void clean(); }}>
            {busy ? "Se curăță…" : "Șterge"}
          </button>
          <button type="button" className="btn" onClick={() => setPanel(false)} disabled={busy}>Renunță</button>
        </div>
      )}
      {done && <p className="cell-sub" role="status" style={{ margin: "6px 0" }}>{done}</p>}

      <KeptList key={`${reason}|${q}|${version}`} reason={reason} q={q} onTotal={setTotal} onOpen={open} openId={openId} />

      {openId && (
        <div className="kept-detail">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <strong>{detail ? `${when(detail.at)} · ${detail.reason}` : "se încarcă…"}</strong>
            <button type="button" className="btn btn-sm" onClick={() => { setOpenId(null); setDetail(null); }}>Închide ×</button>
          </div>
          <pre className="json" style={{ maxHeight: 260, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail ? detail.text + (detail.truncated ? "\n… (tăiat)" : "") : ""}</pre>
        </div>
      )}
    </Widget>
  );
}
