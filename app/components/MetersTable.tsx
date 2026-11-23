"use client";

import dynamic from "next/dynamic";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FLAG, METER_NAME, PROBLEM_FLAGS, activityOf, isStatusOk, type RowView } from "@/lib/meter-shared";
import { metersToCsv } from "@/lib/meter-csv";
import { aggregate, makeCtx, type Agg } from "@/lib/meter-aggregate";
import { NO_FILTERS, activeFilters, runFilter, toQuery, type Filters, type Sort, type SortKey } from "@/lib/meter-filter";
import type { MeterStore } from "@/lib/meter-store";
import { ActiveChips, AdvancedFilters, MainSelects } from "./FilterPanel";
import ColumnFilter, { type ColKey } from "./ColumnFilters";
import MeterCharts from "./MeterCharts";
import MeterDetail from "./MeterDetail";

/** Harta (Leaflet) se încarcă doar când deschizi fila „Hartă”: nu încarcă pagina principală. */
const MeterMap = dynamic(() => import("./MeterMap"), {
  ssr: false,
  loading: () => (
    <div className="empty">
      <h2>Se încarcă harta…</h2>
    </div>
  ),
});
import { useMeterStore, type Origin, type SyncInfo } from "./useMeterStore";

const ROW_H = 52;
const HEADER_H = 86; // rândul cu numele coloanelor (40) + rândul cu filtrele (46)
const OVERSCAN = 8;

const nf = new Intl.NumberFormat("ro-RO");
const nf3 = new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const p2 = (n: number) => String(n).padStart(2, "0");
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `acum ${s} s`;
  if (s < 3600) return `acum ${Math.floor(s / 60)} min`;
  if (s < 86400) return `acum ${Math.floor(s / 3600)} h`;
  return `acum ${Math.floor(s / 86400)} zile`;
}

type Head = { rows: RowView[]; total: number };
type Props = {
  userId: string;
  warm: { gen: string; head: number } | null;
  head: Head;
  initialFilters: Filters;
  initialSort: Sort;
  initialView: "table" | "charts" | "map";
};

const RANGES: [string, string][] = [
  ["", "Tot"],
  ["1h", "1 oră"],
  ["24h", "24 ore"],
  ["7d", "7 zile"],
  ["30d", "30 zile"],
];

/** Filtrele care trăiesc în panoul „Mai multe filtre” (dacă vreunul e activ, panoul se deschide singur). */
const hasAdvanced = (f: Filters) =>
  !!(f.app || f.gw || f.type || f.fr || f.port || f.model || f.year || f.billed || f.geo || f.valMin || f.valMax || f.dcMin || f.dcMax || f.batMin || f.batMax || f.rssiMin || f.rssiMax || f.snrMin || f.snrMax || f.fcMin || f.fcMax);

export default function MetersTable({ userId, warm, head, initialFilters, initialSort, initialView }: Props) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [view, setView] = useState<"table" | "charts" | "map">(initialView);
  const [consPeriod, setConsPeriod] = useState<"month" | "day">("month");
  useEffect(() => {
    const t = setTimeout(() => { try { if (localStorage.getItem("mg:consPeriod") === "day") setConsPeriod("day"); } catch { /* fără alegere reținută */ } }, 0);
    return () => clearTimeout(t);
  }, []);
  const pickPeriod = (p: "month" | "day") => { setConsPeriod(p); try { localStorage.setItem("mg:consPeriod", p); } catch { /* alegerea nu se reține */ } };
  const [advOpen, setAdvOpen] = useState(() => hasAdvanced(initialFilters));
  const [live, setLive] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const { store, rev, status, syncing, offline, origin, info, refresh } = useMeterStore({ userId, warm, live });

  // OPTIMIST: filtrele se aplică în același cadru cu schimbarea (o trecere peste vectori tipizați = câțiva ms), fără amânare.
  // Doar sortarea completă rămâne amânată: săgeata din antet se mută imediat, rândurile urmează când sunt gata.
  const dSort = useDeferredValue(sort);
  const result = useMemo(() => (store ? runFilter(store, filters, dSort) : null), [store, rev, filters, dSort]); // eslint-disable-line react-hooks/exhaustive-deps -- `rev` = lista s-a modificat pe loc
  const pending = dSort !== sort;

  // Agregările graficelor: „toate” (context și numărătorile din liste) depind doar de listă și de intervalul de timp; „filtrate” rulează doar în fila Grafice.
  const ctx = useMemo(() => (store ? makeCtx(store, filters) : null), [store, rev, filters.range, filters.from, filters.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const allAgg = useMemo(() => (store && ctx ? aggregate(store, null, ctx) : null), [store, ctx]);
  const fltAgg = useMemo(() => (view === "charts" && store && ctx && result ? aggregate(store, result.idx, ctx) : null), [view, store, ctx, result]);

  // filtrele (și fila) rămân în URL: refresh / link trimis cuiva păstrează vederea
  useEffect(() => {
    const qs = toQuery(filters, sort, { view: view === "table" ? "" : view });
    window.history.replaceState(window.history.state, "", qs ? `?${qs}` : window.location.pathname);
  }, [filters, sort, view]);

  const patch = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));
  const reset = () => setFilters(NO_FILTERS);
  const nActive = activeFilters(filters);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "dev" || key === "br" || key === "gw" ? 1 : -1 }));

  const nameOf = (id: string) => {
    if (!store) return id;
    const i = store.id.indexOf(id);
    return i >= 0 && i < store.n ? store.nm[i] : id;
  };

  const exportCsv = () => {
    if (!store || !result) return;
    const blob = new Blob([metersToCsv(store, result.idx)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `contoare-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const total = store ? store.n : head.total;
  const newestTs = store && store.n > 0 ? store.ts[store.order[0]] : head.rows[0]?.ts ?? null;
  const ready = !!store && !!result;

  return (
    <div className="page">
      <section className="toolbar" aria-label="Filtre">
        <label className="field">
          <span>Căutare</span>
          <input
            className="input"
            type="search"
            value={filters.q}
            onChange={(e) => patch({ q: e.target.value })}
            placeholder="Nume contor, devEUI, număr radio, cont, adresă, consumator…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <MainSelects store={store} all={allAgg} filters={filters} patch={patch} />

        <div className="toolbar-row2">
          <div className="field">
            <span id="lbl-range">Ultima citire</span>
            <div className="seg" role="group" aria-labelledby="lbl-range">
              {RANGES.map(([v, l]) => (
                <button key={v || "all"} type="button" aria-pressed={!filters.from && !filters.to && filters.range === v} onClick={() => patch({ range: v, from: "", to: "" })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>De la</span>
            <input className="input" type="datetime-local" value={filters.from} max={filters.to || undefined} onChange={(e) => patch({ from: e.target.value, range: "" })} />
          </label>
          <label className="field">
            <span>Până la</span>
            <input className="input" type="datetime-local" value={filters.to} min={filters.from || undefined} onChange={(e) => patch({ to: e.target.value, range: "" })} />
          </label>
          <button type="button" className="btn" aria-expanded={advOpen} aria-controls="adv-filters" onClick={() => setAdvOpen((v) => !v)}>
            Mai multe filtre {advOpen ? "▴" : "▾"}
          </button>
          <div style={{ flex: 1 }} />
          {nActive > 0 && (
            <button type="button" className="btn" onClick={reset}>
              Resetează filtrele ({nActive})
            </button>
          )}
          <button type="button" className="btn" onClick={exportCsv} disabled={!ready || result.matched === 0} title="Exportă contoarele filtrate">
            Export CSV
          </button>
          <button type="button" className="btn" aria-pressed={live} onClick={() => setLive((v) => !v)} title="Actualizare automată la 30 de secunde">
            <span className={`dot ${live ? "live" : ""}`} style={{ margin: 0 }} />
            Live
          </button>
        </div>
        {advOpen && (
          <div id="adv-filters" style={{ gridColumn: "1 / -1" }}>
            <AdvancedFilters store={store} all={allAgg} filters={filters} patch={patch} />
          </div>
        )}
      </section>

      <ActiveChips filters={filters} patch={patch} reset={reset} nameOf={nameOf} />

      <section className="stats" aria-label="Totaluri" aria-live="polite">
        <Stat k="Total contoare" v={nf.format(total)} s={store && store.total !== store.n ? `în baza de date: ${nf.format(store.total)}` : ready ? "toate încărcate" : "se încarcă…"} />
        <Stat k="Filtrate" v={result ? nf.format(result.matched) : "—"} s={result && store && store.n > 0 ? `${((result.matched / store.n) * 100).toFixed(result.matched === store.n ? 0 : 1)}% din total` : " "} busy={pending} />
        <Stat
          k={<span className="stat-k-row">Consum <span className="seg" role="group" aria-label="Perioada consumului"><button type="button" aria-pressed={consPeriod === "day"} onClick={() => pickPeriod("day")}>Azi</button><button type="button" aria-pressed={consPeriod === "month"} onClick={() => pickPeriod("month")}>Luna aceasta</button></span></span>}
          v={result ? `${nf.format(Math.round((consPeriod === "day" ? result.consDay : result.consMonth) / 1000))} m³` : "—"}
          s={result ? `${consPeriod === "day" ? "ziua de azi" : "luna curentă"} · au raportat ${nf.format(consPeriod === "day" ? result.consDayN : result.consMonthN)} din ${nf.format(result.matched)} contoare` : " "}
          busy={pending}
        />
        <Stat k="Alerte" v={result ? nf.format(result.alerts) : "—"} s="baterie slabă / inactiv în SCADA" alert={!!result && result.alerts > 0} busy={pending} />
        <Stat k="Ultima citire" v={newestTs ? fmtTime(newestTs).slice(11) : "—"} s={newestTs ? <Ago ts={newestTs} /> : " "} />
      </section>

      <div className="tabs" role="tablist" aria-label="Vedere">
        <button type="button" role="tab" id="tab-table" aria-selected={view === "table"} aria-controls="panel-view" onClick={() => setView("table")}>
          Tabel
        </button>
        <button type="button" role="tab" id="tab-charts" aria-selected={view === "charts"} aria-controls="panel-view" onClick={() => setView("charts")}>
          Grafice
        </button>
        <button type="button" role="tab" id="tab-map" aria-selected={view === "map"} aria-controls="panel-view" onClick={() => setView("map")}>
          Hartă
        </button>
      </div>

      {view === "table" ? (
        <section className="tablebox" id="panel-view" role="tabpanel" aria-labelledby="tab-table" aria-label="Contoare">
          <Grid
            store={store}
            idx={result?.idx ?? null}
            head={head.rows}
            loading={status === "loading"}
            error={status === "error"}
            sort={sort}
            onSort={onSort}
            onOpen={setOpenId}
            onDevice={(id) => patch({ dev: id })}
            onSerial={(serial) => setFilters({ ...NO_FILTERS, name: serial })}
            selectedId={openId}
            resetKey={`${JSON.stringify(filters)}|${dSort.key}${dSort.dir}`}
            onReset={reset}
            onRetry={refresh}
            hasFilters={nActive > 0}
            all={allAgg}
            filters={filters}
            patch={patch}
          />
        </section>
      ) : view === "map" ? (
        <section className="mapbox" id="panel-view" role="tabpanel" aria-labelledby="tab-map" aria-label="Hartă">
          {store && result ? (
            <MeterMap store={store} idx={result.idx} rev={rev} fitKey={JSON.stringify(filters)} onOpen={setOpenId} />
          ) : (
            <div className="empty">
              <h2>{status === "error" ? "Nu am putut încărca lista" : "Se încarcă lista…"}</h2>
            </div>
          )}
        </section>
      ) : (
        <section className="chartsbox" id="panel-view" role="tabpanel" aria-labelledby="tab-charts" aria-label="Grafice">
          {store && ctx && allAgg && fltAgg ? (
            <MeterCharts store={store} filters={filters} patch={patch} all={allAgg} flt={fltAgg} ctx={ctx} pending={pending} />
          ) : (
            <div className="empty">
              <h2>{status === "error" ? "Nu am putut încărca lista" : "Se încarcă lista…"}</h2>
            </div>
          )}
        </section>
      )}

      <StatusBar live={live} syncing={syncing} offline={offline} origin={origin} info={info} store={store} />
      {openId && <MeterDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/* ───────────────────────── părți mici ───────────────────────── */

function Stat({ k, v, s, alert, busy }: { k: React.ReactNode; v: string; s: React.ReactNode; alert?: boolean; busy?: boolean }) {
  return (
    <div className={`stat ${alert ? "alert" : ""}`} style={busy ? { opacity: 0.6 } : undefined}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="s">{s}</div>
    </div>
  );
}

/** „acum 12 s” care se reîmprospătează singur (nu declanșează re-randarea tabelului). */
function Ago({ ts }: { ts: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const t0 = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, []);
  return <>{now == null ? " " : ago(now - ts)}</>;
}

function StatusBar({ live, syncing, offline, origin, info, store }: { live: boolean; syncing: boolean; offline: boolean; origin: Origin; info: SyncInfo | null; store: MeterStore | null }) {
  const kind = info?.kind === "full" ? "listă completă descărcată" : info?.kind === "delta" ? `Δ ${nf.format(info.added)} contoare actualizate` : info ? "la zi" : "";
  return (
    <div className="statusbar" role="status">
      <span>
        <span className={`dot ${offline ? "off" : live ? "live" : ""}`} />
        {offline ? "Fără conexiune — afișez ultima listă primită" : live ? "Live" : "Pauză"}
        {syncing && " · se sincronizează…"}
      </span>
      {info && (
        <span>
          Sincronizat {fmtTime(info.at).slice(11)} · {kind}
        </span>
      )}
      {origin && <span>Pornit din: {origin}</span>}
      {store && (
        <span style={{ marginLeft: "auto" }}>
          {nf.format(store.n)} contoare în memorie · {nf.format(store.total)} în baza de date
        </span>
      )}
    </div>
  );
}

/* ───────────────────────── grila virtualizată ───────────────────────── */

const COLUMNS: { key: SortKey | null; col: ColKey; label: string; cls?: string }[] = [
  { key: "ts", col: "ts", label: "Ultima citire" },
  { key: "dev", col: "dev", label: "Contor" },
  { key: "br", col: "br", label: "Filială" },
  { key: null, col: "ct", label: "Oraș" },
  { key: "gw", col: "gw", label: "Concentrator" },
  { key: "rssi", col: "rssi", label: "Semnal" },
  { key: "bat", col: "bat", label: "Baterie" },
  { key: "val", col: "val", label: "Volume (m³)", cls: "num" },
  { key: "dc", col: "dc", label: "Consum zi (L)", cls: "num" },
  { key: null, col: "ty", label: "Tip mesaj" },
  { key: null, col: "st", label: "Stare" },
];

type GridProps = {
  store: MeterStore | null;
  idx: Int32Array | null;
  head: RowView[];
  loading: boolean;
  error: boolean;
  sort: Sort;
  onSort: (k: SortKey) => void;
  onOpen: (id: string) => void;
  onDevice: (id: string) => void;
  /** arată toate dispozitivele cu aceeași serie (resetează celelalte filtre) */
  onSerial: (serial: string) => void;
  selectedId: string | null;
  resetKey: string;
  onReset: () => void;
  onRetry: () => void;
  hasFilters: boolean;
  /** filtrele din antet (aceeași stare ca bara de sus) */
  all: Agg | null;
  filters: Filters;
  patch: (p: Partial<Filters>) => void;
};

/**
 * Doar rândurile din fereastra vizibilă (+ câteva de rezervă) există în DOM: la zeci de mii de contoare sunt ~25 de elemente.
 * Înălțimea rândului e fixă ⇒ poziția fiecărui rând = index × ROW_H, fără măsurători. Starea de derulare stă AICI, nu în părinte:
 * derularea nu re-randează bara de filtre.
 */
function Grid(p: GridProps) {
  const { store, idx, head, sort } = p;
  const vpRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ top: 0, h: 600 });
  // „acum” pentru treptele de activitate; se reîmprospătează la un minut (re-randează doar rândurile vizibile)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      setVp((v) => (v.top === el.scrollTop && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  // alt filtru / altă sortare ⇒ înapoi sus
  useEffect(() => {
    if (vpRef.current) vpRef.current.scrollTop = 0;
  }, [p.resetKey]);

  const count = idx ? idx.length : 0;
  const first = Math.max(0, Math.floor((vp.top - HEADER_H) / ROW_H) - OVERSCAN);
  const last = Math.min(count, Math.ceil((vp.top + vp.h) / ROW_H) + OVERSCAN);

  const rows: React.ReactNode[] = [];
  if (store && idx) {
    for (let i = first; i < last; i++) rows.push(<Row key={store.id[idx[i]]} r={store.view(idx[i])} i={i} top={i * ROW_H} selected={store.id[idx[i]] === p.selectedId} onOpen={p.onOpen} onDevice={p.onDevice} onSerial={p.onSerial} now={now} />);
  }

  const headMode = !idx; // lista completă încă nu e gata: primele rânduri vin din HTML
  const empty = idx && count === 0;

  return (
    <div className="vp" ref={vpRef} role="table" aria-label="Contoare" aria-rowcount={count + 1} aria-busy={p.loading}>
      <div className="tbl">
        <div className="hdrs">
          <div className="hdr" role="row">
            {COLUMNS.map((c) => (
              <div key={c.label} role="columnheader" aria-sort={c.key && sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined} className={c.cls}>
                {c.key ? (
                  <button type="button" data-on={sort.key === c.key ? 1 : 0} onClick={() => p.onSort(c.key as SortKey)} style={c.cls === "num" ? { justifyContent: "flex-end", width: "100%" } : undefined}>
                    {c.label}
                    <span aria-hidden="true">{sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
                  </button>
                ) : (
                  <span className="plain">{c.label}</span>
                )}
              </div>
            ))}
          </div>
          <div className="fltr" role="row" aria-label="Filtre pe coloane">
            {COLUMNS.map((c) => (
              <div key={c.label} role="cell">
                <ColumnFilter col={c.col} store={store} all={p.all} filters={p.filters} patch={p.patch} />
              </div>
            ))}
          </div>
        </div>

        {headMode && !p.error && (
          <div role="rowgroup">
            {head.map((r, i) => (
              <Row key={r.id} r={r} i={i} top={0} selected={r.id === p.selectedId} onOpen={p.onOpen} onDevice={p.onDevice} onSerial={p.onSerial} flow now={now} />
            ))}
            {head.length === 0 && p.loading && <SkeletonRows />}
            {p.loading && head.length > 0 && <div className="cell-sub" style={{ padding: 14 }}>Se încarcă lista completă…</div>}
          </div>
        )}

        {p.error && headMode && (
          <div className="empty">
            <h2>Nu am putut încărca lista</h2>
            <button className="btn btn-primary" onClick={p.onRetry}>
              Încearcă din nou
            </button>
          </div>
        )}

        {store && idx && !empty && (
          <div className="body" role="rowgroup" style={{ height: count * ROW_H }}>
            {rows}
          </div>
        )}

        {empty && store && store.n === 0 && (
          <div className="empty">
            <h2>Nu există contoare în baza de date</h2>
            <p style={{ margin: 0 }}>
              Rulează sincronizarea: <code>npm run sync:meters</code> (citește SCADA și getmgdb).
            </p>
          </div>
        )}
        {empty && store && store.n > 0 && (
          <div className="empty">
            <h2>Niciun contor pentru filtrele curente</h2>
            {p.hasFilters && (
              <button className="btn" onClick={p.onReset}>
                Resetează filtrele
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="row static" style={{ height: ROW_H, cursor: "default" }}>
          {COLUMNS.map((_, j) => (
            <div key={j}>
              <div className="skeleton" style={{ height: 12, width: `${55 + ((i * 7 + j * 13) % 40)}%` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function sigClass(rssi: number | null): string {
  if (rssi == null) return "";
  return rssi >= -105 ? "good" : rssi >= -115 ? "mid" : "bad";
}

function Row({ r, i, top, selected, onOpen, onDevice, onSerial, flow, now }: { r: RowView; i: number; top: number; selected: boolean; onOpen: (id: string) => void; onDevice: (id: string) => void; onSerial: (serial: string) => void; flow?: boolean; now: number }) {
  const f = r.fl;
  const act = activityOf(r.ts, now); // 0 activ 24 h · 1 avertizare 1–7 zile · 2 critic > 7 zile · 3 fără citire (ca în SCADA)
  const statusOk = isStatusOk(f); // „OK” = raport de stare fără probleme (inactiv / serie repetată se afișează în plus)
  const anyBadge = statusOk || (f & (PROBLEM_FLAGS | FLAG.INACTIVE | FLAG.DUP | FLAG.OFFLINE)) !== 0 || act === 1 || act === 2;
  const serial = METER_NAME.exec(r.name)?.[2];
  return (
    <div
      className={`row ${flow ? "static" : ""}`}
      role="row"
      aria-rowindex={i + 2}
      aria-selected={selected}
      tabIndex={0}
      style={flow ? { height: ROW_H } : { top, height: ROW_H }}
      onClick={() => onOpen(r.id)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen(r.id);
        }
      }}
    >
      <div role="cell">
        {r.ts > 0 ? (
          <>
            <div className="mono cell-main" suppressHydrationWarning>{fmtTime(r.ts).slice(11)}</div>
            <div className="cell-sub mono" suppressHydrationWarning>{fmtTime(r.ts).slice(0, 10)}</div>
          </>
        ) : (
          <div className="cell-sub">fără citiri</div>
        )}
      </div>
      <div role="cell">
        <button
          type="button"
          className="dev-link"
          title={`Filtrează după ${r.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDevice(r.id);
          }}
        >
          {r.name || r.eui || "—"}
        </button>
        <div className="cell-sub mono">{r.eui || " "}</div>
      </div>
      <div role="cell">
        <div className="cell-main" title={r.branch ?? undefined}>{r.branch ?? "—"}</div>
      </div>
      <div role="cell">
        <div className="cell-main" title={r.city ?? undefined}>{r.city && r.city !== "—" ? r.city : <span className="cell-sub">—</span>}</div>
      </div>
      <div role="cell">
        <div className="cell-main" title={r.gw ?? undefined}>{r.gw ?? "—"}</div>
        <div className="cell-sub mono">{r.freqKhz ? `${(r.freqKhz / 1000).toFixed(1)} MHz` : " "}</div>
      </div>
      <div role="cell">
        <div className="mono cell-main">
          <span className={`sig ${sigClass(r.rssi)}`} aria-hidden="true" />
          {r.rssi != null ? `${r.rssi} dBm` : "—"}
        </div>
        <div className="cell-sub mono">{r.snr != null ? `SNR ${Math.round(r.snr * 10) / 10}` : " "}</div>
      </div>
      <div role="cell">
        <div className={`mono cell-main ${r.bat != null && r.bat < 20 ? "low" : ""}`}>{r.bat != null ? `${Math.round(r.bat)}%` : "—"}</div>
      </div>
      <div role="cell" className="num mono cell-main">
        {r.val != null ? nf3.format(r.val) : <span className="cell-sub">—</span>}
      </div>
      <div role="cell" className="num mono">
        {r.dc != null ? nf.format(r.dc) : <span className="cell-sub">—</span>}
        {r.mc != null && <div className="cell-sub">lună: {nf.format(r.mc)}</div>}
      </div>
      <div role="cell">
        {r.types.length === 0 ? <span className="cell-sub">—</span> : (
          <div className="badges" title={r.types.join(", ")}>
            <span className="badge type">{r.types[0]}</span>
            {r.types.length > 1 && <span className="badge">+{r.types.length - 1}</span>}
          </div>
        )}
      </div>
      <div role="cell">
        <div className="badges">
          {act === 1 ? <span className="badge warn" title="Ultima citire acum 1–7 zile">Avertizare</span> : null}
          {act === 2 ? <span className="badge danger" title="Ultima citire acum mai mult de 7 zile">Critic</span> : null}
          {f & FLAG.OFFLINE ? <span className="badge" title="Câmpul „offline” trimis de contor în propriul mesaj. Nu înseamnă că nu comunică.">Raportat offline</span> : null}
          {f & FLAG.BATT ? <span className="badge danger">Baterie slabă</span> : null}
          {f & FLAG.INACTIVE ? <span className="badge danger" title="Inactiv în SCADA (atributul active = false)">Inactiv</span> : null}
          {f & FLAG.DUP ? (
            <button type="button" className="badge warn badge-btn" title={`Același număr radio (${serial ?? "?"}) apare la mai multe dispozitive. Click: arată-le împreună.`} onClick={(e) => { e.stopPropagation(); if (serial) onSerial(serial); }}>
              Serie repetată
            </button>
          ) : null}
          {f & FLAG.BTN ? <span className="badge warn">Buton</span> : null}
          {f & FLAG.MAG ? <span className="badge warn">Magnet</span> : null}
          {statusOk ? <span className="badge ok">OK</span> : null}
          {!anyBadge ? <span className="cell-sub">—</span> : null}
        </div>
      </div>
    </div>
  );
}
