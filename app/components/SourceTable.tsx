"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { SOURCES, type ColDef, type SourceId } from "@/lib/source-shared";
import { NO_SFILTERS, activeCount, describeFilters, dictCounts, runFilter, setSel, toQuery, type SFilters } from "@/lib/source-filter";
import { sourceToCsv } from "@/lib/source-csv";
import type { SortSpec, SourceStore } from "@/lib/source-store";
import { MultiSelect } from "./FilterPanel";
import { AdvancedPanel, ColFilter, buildOptions, hasAdvanced, type OptionsMap, type SetF } from "./SourceFilters";
import SourceCharts from "./SourceCharts";
import SourceDetail from "./SourceDetail";
import { useSourceStore, type SourceInfo, type SourceOrigin } from "./useSourceStore";

const ROW_H = 48;
const HEADER_H = 86; // rândul cu numele coloanelor (40) + rândul cu filtrele (46)
const OVERSCAN = 8;

const nf = new Intl.NumberFormat("ro-RO");
const p2 = (n: number) => String(n).padStart(2, "0");
const fmtDate = (ms: number) => `${p2(new Date(ms).getDate())}.${p2(new Date(ms).getMonth() + 1)}.${new Date(ms).getFullYear()}`;
const fmtClock = (ms: number) => `${p2(new Date(ms).getHours())}:${p2(new Date(ms).getMinutes())}:${p2(new Date(ms).getSeconds())}`;

type Props = { userId: string; source: SourceId; initialFilters: SFilters; initialSort: SortSpec; initialView: "table" | "charts" };

/**
 * Pagina unei surse (lorawandb sau getmgdb): aceleași instrumente ca pagina principală — căutare, filtre (și în antetul fiecărei coloane),
 * totaluri, tabel virtualizat, grafice, detalii pe rând, export CSV — dar numai cu datele din acea sursă. Coloanele vin de la server (`cols`).
 */
export default function SourceTable({ userId, source, initialFilters, initialSort, initialView }: Props) {
  const meta = SOURCES[source];
  const [filters, setFilters] = useState<SFilters>(initialFilters);
  const [sort, setSort] = useState<SortSpec>(initialSort);
  const [view, setView] = useState<"table" | "charts">(initialView);
  const [advOpen, setAdvOpen] = useState(false);
  const [live, setLive] = useState(true);
  const [open, setOpen] = useState<{ st: SourceStore; i: number } | null>(null);
  const { store, status, syncing, offline, origin, info, refresh } = useSourceStore({ userId, source, live });

  const setF: SetF = (fn) => setFilters(fn);
  const dSort = useDeferredValue(sort);
  const pending = dSort !== sort;
  const result = useMemo(() => (store ? runFilter(store, filters, dSort) : null), [store, filters, dSort]);

  // numărătorile din TOATE rândurile (în liste) și din cele filtrate (în totaluri)
  const allCounts = useMemo(() => (store ? Object.fromEntries(store.cols.filter((c) => c.kind === "dict").map((c) => [c.key, dictCounts(store, c.key, null)])) : null), [store]);
  const options = useMemo<OptionsMap>(() => buildOptions(store, allCounts), [store, allCounts]);
  const statCols = useMemo(() => (store ? store.cols.filter((c) => c.kind === "dict" && (c.kpi || c.yes)) : []), [store]);
  const statCounts = useMemo(() => (store && result ? Object.fromEntries(statCols.map((c) => [c.key, dictCounts(store, c.key, result.idx)])) : null), [store, result, statCols]);

  // filtrele (și fila) rămân în URL: refresh / link trimis cuiva păstrează vederea
  useEffect(() => {
    const qs = toQuery(filters, sort, meta.defaultSort, { view: view === "table" ? "" : view });
    window.history.replaceState(window.history.state, "", qs ? `?${qs}` : window.location.pathname);
  }, [filters, sort, view, meta.defaultSort]);

  const nActive = activeCount(filters);
  const reset = () => setFilters(NO_SFILTERS);
  const chips = useMemo(() => describeFilters(filters, store), [filters, store]);
  const forcedAdv = hasAdvanced(filters, store?.cols);
  const showAdv = advOpen || forcedAdv;

  const onSort = (key: string) => {
    const c = store?.byKey.get(key);
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: c && (c.kind === "num" || c.kind === "date") ? -1 : 1 }));
  };

  const exportCsv = () => {
    if (!store || !result) return;
    const blob = new Blob([sourceToCsv(store, result.idx)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${source === "lorawan" ? "dispozitive-lorawan" : "facturare"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const ready = !!store && !!result;
  const mainCols = useMemo(() => (store ? store.cols.filter((c) => c.main && c.kind === "dict").slice(0, 4) : []), [store]);
  // cea mai recentă dată din coloana după care se sortează implicit (ex. ultima actualizare din facturare)
  const recent = useMemo(() => {
    const c = store?.byKey.get(meta.defaultSort.key);
    if (!store || !c || c.kind !== "date") return null;
    let mx = NaN;
    for (const x of store.nums[c.key]) if (x === x && (mx !== mx || x > mx)) mx = x;
    return mx === mx ? { label: c.label, t: mx } : null;
  }, [store, meta.defaultSort.key]);

  return (
    <div className="page">
      <section className="toolbar" aria-label="Filtre">
        <label className="field">
          <span>Căutare</span>
          <input className="input" type="search" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder={meta.searchHint} autoComplete="off" spellCheck={false} />
        </label>
        {mainCols.map((c) => (
          <MultiSelect key={c.key} label={c.label} options={options[c.key] ?? []} selected={filters.sel[c.key] ?? []} onChange={(v) => setFilters((f) => setSel(f, c.key, v))} />
        ))}
        {/* cât timp lista nu e încărcată, păstrăm locul listelor ca bara să nu sară */}
        {!store && Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 52, borderRadius: 8 }} aria-hidden="true" />)}

        <div className="toolbar-row2">
          <button type="button" className="btn" aria-expanded={showAdv} aria-controls="adv-filters" onClick={() => setAdvOpen((v) => !v)}>
            Mai multe filtre {showAdv ? "▴" : "▾"}
          </button>
          <div style={{ flex: 1 }} />
          {nActive > 0 && (
            <button type="button" className="btn" onClick={reset}>
              Resetează filtrele ({nActive})
            </button>
          )}
          <button type="button" className="btn" onClick={exportCsv} disabled={!ready || result.matched === 0} title="Exportă rândurile filtrate (fără datele personale ale consumatorilor)">
            Export CSV
          </button>
          <button type="button" className="btn" aria-pressed={live} onClick={() => setLive((v) => !v)} title="Verificare automată la 60 de secunde">
            <span className={`dot ${live ? "live" : ""}`} style={{ margin: 0 }} />
            Live
          </button>
        </div>
        {showAdv && (
          <div id="adv-filters" style={{ gridColumn: "1 / -1" }}>
            <AdvancedPanel store={store} options={options} f={filters} setF={setF} />
          </div>
        )}
      </section>

      {chips.length > 0 && (
        <div className="chips" role="group" aria-label="Filtre active">
          {chips.map((c) => (
            <span key={c.id} className="chip-x">
              {c.label}
              <button type="button" onClick={() => setFilters(c.clear)} aria-label={`Elimină filtrul: ${c.label}`}>
                ×
              </button>
            </span>
          ))}
          {chips.length > 1 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={reset}>
              Șterge toate
            </button>
          )}
        </div>
      )}

      <section className="stats auto" aria-label="Totaluri" aria-live="polite">
        <Stat k={`Total ${meta.nounPlural}`} v={store ? nf.format(store.n) : "—"} s={ready ? "toate încărcate" : status === "error" ? "nu s-au putut încărca" : "se încarcă…"} />
        <Stat k="Filtrate" v={result ? nf.format(result.matched) : "—"} s={result && store && store.n > 0 ? `${((result.matched / store.n) * 100).toFixed(result.matched === store.n ? 0 : 1)}% din total` : " "} busy={pending} />
        {statCols.map((c) => {
          const cnt = statCounts?.[c.key];
          const names = store?.dict[c.key] ?? [];
          let v = "—";
          if (cnt) {
            if (c.kpi) v = nf.format(Array.from(cnt.subarray(0, names.length)).filter((x) => x > 0).length);
            else v = nf.format(cnt[names.indexOf("Da")] ?? 0);
          }
          return <Stat key={c.key} k={c.kpi ?? c.yes ?? c.label} v={v} s={c.kpi ? "valori distincte (filtrate)" : "în rândurile filtrate"} alert={!!c.yes && v !== "—" && v !== "0"} busy={pending} />;
        })}
        {recent && <Stat k="Cel mai recent" v={fmtDate(recent.t)} s={recent.label} />}
      </section>

      <div className="tabs" role="tablist" aria-label="Vedere">
        <button type="button" role="tab" id="tab-table" aria-selected={view === "table"} aria-controls="panel-view" onClick={() => setView("table")}>
          Tabel
        </button>
        <button type="button" role="tab" id="tab-charts" aria-selected={view === "charts"} aria-controls="panel-view" onClick={() => setView("charts")}>
          Grafice
        </button>
      </div>

      {view === "table" ? (
        <section className="tablebox" id="panel-view" role="tabpanel" aria-labelledby="tab-table" aria-label={meta.title}>
          <Grid
            store={store}
            idx={result?.idx ?? null}
            loading={status === "loading"}
            error={status === "error"}
            sort={sort}
            onSort={onSort}
            onOpen={(i) => store && setOpen({ st: store, i })}
            resetKey={`${JSON.stringify(filters)}|${dSort.key}${dSort.dir}`}
            onReset={reset}
            onRetry={refresh}
            hasFilters={nActive > 0}
            options={options}
            filters={filters}
            setF={setF}
            noun={meta.nounPlural}
            selected={open?.st === store ? open.i : -1}
          />
        </section>
      ) : (
        <section className="chartsbox" id="panel-view" role="tabpanel" aria-labelledby="tab-charts" aria-label="Grafice">
          {store && result ? (
            <SourceCharts store={store} filters={filters} setF={setF} idx={result.idx} pending={pending} noun={meta.nounPlural} />
          ) : (
            <div className="empty">
              <h2>{status === "error" ? "Nu am putut încărca lista" : "Se încarcă lista…"}</h2>
            </div>
          )}
        </section>
      )}

      <StatusBar live={live} syncing={syncing} offline={offline} origin={origin} info={info} store={store} />
      {open && (
        <SourceDetail
          store={open.st}
          i={open.i}
          onClose={() => setOpen(null)}
          onSeries={(key, value) => {
            setOpen(null);
            setFilters({ ...NO_SFILTERS, txt: { [key]: value } });
          }}
        />
      )}
    </div>
  );
}

/* ───────────────────────── părți mici ───────────────────────── */

function Stat({ k, v, s, alert, busy }: { k: string; v: string; s: React.ReactNode; alert?: boolean; busy?: boolean }) {
  return (
    <div className={`stat ${alert ? "alert" : ""}`} style={busy ? { opacity: 0.6 } : undefined}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="s">{s}</div>
    </div>
  );
}

function StatusBar({ live, syncing, offline, origin, info, store }: { live: boolean; syncing: boolean; offline: boolean; origin: SourceOrigin; info: SourceInfo | null; store: SourceStore | null }) {
  return (
    <div className="statusbar" role="status">
      <span>
        <span className={`dot ${offline ? "off" : live ? "live" : ""}`} />
        {offline ? "Fără conexiune — afișez ultima listă primită" : live ? "Live" : "Pauză"}
        {syncing && " · se verifică…"}
      </span>
      {info && (
        <span>
          Verificat {fmtClock(info.at)} · {info.kind === "full" ? "listă descărcată" : "la zi (nimic nou)"}
        </span>
      )}
      {origin && <span>Pornit din: {origin}</span>}
      {store && <span style={{ marginLeft: "auto" }}>{nf.format(store.n)} rânduri în memorie</span>}
    </div>
  );
}

/* ───────────────────────── grila virtualizată ───────────────────────── */

const colW = (c: ColDef) => c.w ?? 140;

type GridProps = {
  store: SourceStore | null;
  idx: Int32Array | null;
  loading: boolean;
  error: boolean;
  sort: SortSpec;
  onSort: (key: string) => void;
  onOpen: (i: number) => void;
  resetKey: string;
  onReset: () => void;
  onRetry: () => void;
  hasFilters: boolean;
  options: OptionsMap;
  filters: SFilters;
  setF: SetF;
  noun: string;
  selected: number;
};

/**
 * Doar rândurile din fereastra vizibilă (+ câteva de rezervă) există în DOM, oricâte rânduri are sursa. Înălțimea rândului e fixă ⇒ poziția fiecărui
 * rând = index × ROW_H, fără măsurători. Starea de derulare stă AICI, nu în părinte: derularea nu re-randează bara de filtre.
 */
function Grid(p: GridProps) {
  const { store, idx, sort } = p;
  const vpRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ top: 0, h: 600 });
  const cols = useMemo(() => (store ? store.cols.filter((c) => c.show) : []), [store]);
  const tplCols = useMemo(() => cols.map((c) => `minmax(${colW(c)}px, ${colW(c)}fr)`).join(" "), [cols]);
  const minW = useMemo(() => cols.reduce((a, c) => a + colW(c), 0), [cols]);

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
  const empty = !!idx && count === 0;
  const tblStyle = { "--cols": tplCols, minWidth: Math.max(minW, 600) } as React.CSSProperties;

  const rows: React.ReactNode[] = [];
  if (store && idx) {
    for (let i = first; i < last; i++) rows.push(<Row key={idx[i]} store={store} cols={cols} r={idx[i]} i={i} top={i * ROW_H} selected={p.selected === idx[i]} onOpen={p.onOpen} />);
  }

  return (
    <div className="vp" ref={vpRef} role="table" aria-label={p.noun} aria-rowcount={count + 1} aria-busy={p.loading}>
      <div className="tbl" style={tblStyle}>
        <div className="hdrs">
          <div className="hdr" role="row">
            {cols.map((c) => (
              <div key={c.key} role="columnheader" aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined} className={c.kind === "num" ? "num" : undefined}>
                <button type="button" title={c.hint} data-on={sort.key === c.key ? 1 : 0} onClick={() => p.onSort(c.key)} style={c.kind === "num" ? { justifyContent: "flex-end", width: "100%" } : undefined}>
                  {c.label}
                  <span aria-hidden="true">{sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
                </button>
              </div>
            ))}
            {!store && <div className="plain" style={{ gridColumn: "1 / -1", padding: "0 12px" }}><span className="plain">Se încarcă coloanele…</span></div>}
          </div>
          <div className="fltr" role="row" aria-label="Filtre pe coloane">
            {cols.map((c, k) => (
              <div key={c.key} role="cell">
                <ColFilter c={c} options={p.options} f={p.filters} setF={p.setF} compact align={k >= cols.length * 0.6 ? "right" : "left"} />
              </div>
            ))}
          </div>
        </div>

        {!idx && !p.error && <SkeletonRows n={cols.length || 6} />}

        {p.error && !idx && (
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
            <h2>Nu există date în baza de date</h2>
            <p style={{ margin: 0 }}>
              Rulează sincronizarea: <code>npm run sync:sources</code> (citește lorawandb și getmgdb).
            </p>
          </div>
        )}
        {empty && store && store.n > 0 && (
          <div className="empty">
            <h2>Niciun rând pentru filtrele curente</h2>
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

function SkeletonRows({ n }: { n: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="row static" style={{ height: ROW_H, cursor: "default" }}>
          {Array.from({ length: n }, (_, j) => (
            <div key={j}>
              <div className="skeleton" style={{ height: 12, width: `${55 + ((i * 7 + j * 13) % 40)}%` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Cell({ store, c, r }: { store: SourceStore; c: ColDef; r: number }) {
  if (c.kind === "date") {
    const t = store.nums[c.key][r];
    if (t !== t) return <span className="cell-sub">—</span>;
    return c.time ? (
      <>
        <div className="mono cell-main" suppressHydrationWarning>{fmtClock(t)}</div>
        <div className="cell-sub mono" suppressHydrationWarning>{fmtDate(t)}</div>
      </>
    ) : (
      <div className="mono cell-main" suppressHydrationWarning>{fmtDate(t)}</div>
    );
  }
  if (c.kind === "num") {
    const v = store.nums[c.key][r];
    return v === v ? <span className="mono cell-main">{nf.format(v)}</span> : <span className="cell-sub">—</span>;
  }
  const raw = store.text(r, c);
  if (!raw) return <span className="cell-sub">—</span>;
  if (c.yes) return raw === "Da" ? <span className="badge warn">Da</span> : <span className="cell-sub">—</span>;
  const shown = store.label(c, raw);
  return (
    <div className={`cell-main ${c.mono ? "mono" : ""}`} title={raw}>
      {shown}
    </div>
  );
}

function Row({ store, cols, r, i, top, selected, onOpen }: { store: SourceStore; cols: ColDef[]; r: number; i: number; top: number; selected: boolean; onOpen: (i: number) => void }) {
  return (
    <div
      className="row"
      role="row"
      aria-rowindex={i + 2}
      aria-selected={selected}
      tabIndex={0}
      style={{ top, height: ROW_H }}
      onClick={() => onOpen(r)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen(r);
        }
      }}
    >
      {cols.map((c) => (
        <div key={c.key} role="cell" className={c.kind === "num" ? "num" : undefined}>
          <Cell store={store} c={c} r={r} />
        </div>
      ))}
    </div>
  );
}
