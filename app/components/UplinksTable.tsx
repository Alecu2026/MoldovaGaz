"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FLAG, type RowView } from "@/lib/uplink-shared";
import { uplinksToCsv } from "@/lib/uplink-csv";
import {
  DEFAULT_SORT,
  NO_FILTERS,
  activeFilters,
  runFilter,
  toQuery,
  type Filters,
  type Sort,
  type SortKey,
} from "@/lib/uplink-filter";
import type { UplinkStore } from "@/lib/uplink-store";
import UplinkDetail from "./UplinkDetail";
import { useUplinkStore, type Origin, type SyncInfo } from "./useUplinkStore";

const ROW_H = 52;
const HEADER_H = 40;
const OVERSCAN = 8;

const nf = new Intl.NumberFormat("ro-RO");
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
};

const RANGES: [string, string][] = [
  ["", "Tot"],
  ["1h", "1 oră"],
  ["24h", "24 ore"],
  ["7d", "7 zile"],
  ["30d", "30 zile"],
];
const FLAG_OPTIONS: [string, string][] = [
  ["alert", "Alerte (baterie / offline)"],
  ["batt", "Baterie slabă"],
  ["offline", "Offline"],
  ["button", "Buton apăsat"],
  ["magnet", "Magnet detectat"],
];

export default function UplinksTable({ userId, warm, head, initialFilters, initialSort }: Props) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [live, setLive] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const { store, rev, status, syncing, offline, origin, info, refresh } = useUplinkStore({ userId, warm, live });

  // OPTIMIST: filtrele se aplică în același cadru cu schimbarea (o trecere peste vectori tipizați = 1–5 ms la 300.000 de rânduri), fără amânare.
  // Doar sortarea completă (~250 ms la 300.000) rămâne amânată: săgeata din antet se mută imediat, rândurile urmează când sunt gata.
  const dSort = useDeferredValue(sort);
  const result = useMemo(() => (store ? runFilter(store, filters, dSort) : null), [store, rev, filters, dSort]); // eslint-disable-line react-hooks/exhaustive-deps -- `rev` = lista s-a modificat pe loc
  const pending = dSort !== sort;

  // filtrele rămân în URL (refresh / link trimis cuiva păstrează vederea)
  useEffect(() => {
    const qs = toQuery(filters, sort);
    window.history.replaceState(window.history.state, "", qs ? `?${qs}` : window.location.pathname);
  }, [filters, sort]);

  const patch = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));
  const reset = () => setFilters(NO_FILTERS);
  const nActive = activeFilters(filters);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "dev" || key === "gw" ? 1 : -1 }));

  const devLabel = useMemo(() => {
    if (!filters.dev || !store) return filters.dev;
    const e = store.dict.dev.find((d) => d[1] === filters.dev || d[0] === filters.dev);
    return e?.[0] || filters.dev;
  }, [filters.dev, store, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCsv = () => {
    if (!store || !result) return;
    const blob = new Blob([uplinksToCsv(store, result.idx)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mesaje-lorawan-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
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
            placeholder="Dispozitiv, devEUI, gateway, tip, fCnt…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Select label="Aplicație" value={filters.app} onChange={(v) => patch({ app: v })} options={store?.dict.ap ?? []} />
        <Select label="Gateway" value={filters.gw} onChange={(v) => patch({ gw: v })} options={store?.dict.gw ?? []} />
        <Select label="Tip mesaj" value={filters.type} onChange={(v) => patch({ type: v })} options={store?.dict.ty ?? []} />
        <label className="field">
          <span>Stare</span>
          <select className="select" value={filters.flag} onChange={(e) => patch({ flag: e.target.value })}>
            <option value="">Toate</option>
            {FLAG_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <div className="toolbar-row2">
          <div className="field">
            <span id="lbl-range">Perioadă</span>
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
          {filters.dev && (
            <div className="field">
              <span>Dispozitiv</span>
              <span className="chip-x">
                {devLabel}
                <button type="button" onClick={() => patch({ dev: "" })} aria-label="Elimină filtrul de dispozitiv">
                  ×
                </button>
              </span>
            </div>
          )}
          <div style={{ flex: 1 }} />
          {nActive > 0 && (
            <button type="button" className="btn" onClick={reset}>
              Resetează filtrele ({nActive})
            </button>
          )}
          <button type="button" className="btn" onClick={exportCsv} disabled={!ready || result.matched === 0} title="Exportă rândurile filtrate">
            Export CSV
          </button>
          <button type="button" className="btn" aria-pressed={live} onClick={() => setLive((v) => !v)} title="Actualizare automată la 10 secunde">
            <span className={`dot ${live ? "live" : ""}`} style={{ margin: 0 }} />
            Live
          </button>
        </div>
      </section>

      <section className="stats" aria-label="Totaluri" aria-live="polite">
        <Stat k="Total mesaje" v={nf.format(total)} s={store && store.total > store.n ? `din ${nf.format(store.total)} în baza de date` : ready ? "toate încărcate" : "se încarcă…"} />
        <Stat k="Filtrate" v={result ? nf.format(result.matched) : "—"} s={result && store && store.n > 0 ? `${((result.matched / store.n) * 100).toFixed(result.matched === store.n ? 0 : 1)}% din total` : " "} busy={pending} />
        <Stat k="Dispozitive" v={result ? nf.format(result.devices) : "—"} s={store ? `din ${nf.format(store.dict.dev.length)}` : " "} busy={pending} />
        <Stat k="Alerte" v={result ? nf.format(result.alerts) : "—"} s="baterie slabă / offline" alert={!!result && result.alerts > 0} busy={pending} />
        <Stat k="Ultimul mesaj" v={newestTs ? fmtTime(newestTs).slice(11) : "—"} s={newestTs ? <Ago ts={newestTs} /> : " "} />
      </section>

      <section className="tablebox" aria-label="Mesaje LoRaWAN">
        <Grid
          store={store}
          rev={rev}
          idx={result?.idx ?? null}
          head={head.rows}
          loading={status === "loading"}
          error={status === "error"}
          sort={sort}
          onSort={onSort}
          onOpen={setOpenId}
          onDevice={(eui) => patch({ dev: eui })}
          selectedId={openId}
          resetKey={`${JSON.stringify(filters)}|${dSort.key}${dSort.dir}`}
          anchorable={dSort.key === DEFAULT_SORT.key && dSort.dir === DEFAULT_SORT.dir}
          onReset={reset}
          onRetry={refresh}
          hasFilters={nActive > 0}
        />
      </section>

      <StatusBar live={live} syncing={syncing} offline={offline} origin={origin} info={info} store={store} />
      {openId && <UplinkDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/* ───────────────────────── părți mici ───────────────────────── */

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  const list = options.filter(Boolean);
  const all = value && !list.includes(value) ? [value, ...list] : list; // valoarea din URL apare și cât timp lista încă se încarcă
  return (
    <label className="field">
      <span>{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Toate</option>
        {all.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Stat({ k, v, s, alert, busy }: { k: string; v: string; s: React.ReactNode; alert?: boolean; busy?: boolean }) {
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

function StatusBar({ live, syncing, offline, origin, info, store }: { live: boolean; syncing: boolean; offline: boolean; origin: Origin; info: SyncInfo | null; store: UplinkStore | null }) {
  const kind = info?.kind === "full" ? "listă completă descărcată" : info?.kind === "delta" ? `Δ +${nf.format(info.added)} mesaje noi` : info ? "la zi" : "";
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
          {nf.format(store.n)} rânduri în memorie · {nf.format(store.total)} în baza de date
        </span>
      )}
    </div>
  );
}

/* ───────────────────────── grila virtualizată ───────────────────────── */

const COLUMNS: { key: SortKey | null; label: string; cls?: string }[] = [
  { key: "ts", label: "Timp" },
  { key: "dev", label: "Dispozitiv" },
  { key: "gw", label: "Gateway" },
  { key: "rssi", label: "Semnal" },
  { key: "dr", label: "Radio" },
  { key: "fc", label: "Cadru" },
  { key: null, label: "Tip mesaj" },
  { key: "val", label: "Valoare", cls: "num" },
  { key: null, label: "Stare" },
];

type GridProps = {
  store: UplinkStore | null;
  rev: number;
  idx: Int32Array | null;
  head: RowView[];
  loading: boolean;
  error: boolean;
  sort: Sort;
  onSort: (k: SortKey) => void;
  onOpen: (id: string) => void;
  onDevice: (eui: string) => void;
  selectedId: string | null;
  resetKey: string;
  anchorable: boolean;
  onReset: () => void;
  onRetry: () => void;
  hasFilters: boolean;
};

/**
 * Doar rândurile din fereastra vizibilă (+ câteva de rezervă) există în DOM: la 300.000 de rânduri sunt ~25 de elemente, nu 300.000.
 * Înălțimea rândului e fixă ⇒ poziția fiecărui rând = index × ROW_H, fără măsurători. Starea de derulare stă AICI, nu în părinte:
 * derularea nu re-randează bara de filtre.
 */
function Grid(p: GridProps) {
  const { store, idx, head, sort } = p;
  const vpRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ top: 0, h: 600 });

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

  // mesaje noi sosesc deasupra: cine citește mai jos rămâne pe aceleași rânduri
  const prev = useRef({ count: 0, key: "" });
  const count = idx ? idx.length : 0;
  useEffect(() => {
    const el = vpRef.current;
    const was = prev.current;
    if (el && p.anchorable && was.key === p.resetKey && count > was.count && el.scrollTop > ROW_H) el.scrollTop += (count - was.count) * ROW_H;
    prev.current = { count, key: p.resetKey };
  }, [count, p.resetKey, p.anchorable]);

  const first = Math.max(0, Math.floor((vp.top - HEADER_H) / ROW_H) - OVERSCAN);
  const last = Math.min(count, Math.ceil((vp.top + vp.h) / ROW_H) + OVERSCAN);

  const rows: React.ReactNode[] = [];
  if (store && idx) {
    for (let i = first; i < last; i++) rows.push(<Row key={store.id[idx[i]]} r={store.view(idx[i])} i={i} top={i * ROW_H} selected={store.id[idx[i]] === p.selectedId} onOpen={p.onOpen} onDevice={p.onDevice} />);
  }

  const headMode = !idx; // lista completă încă nu e gata: primele rânduri vin din HTML
  const empty = idx && count === 0;

  return (
    <div className="vp" ref={vpRef} role="table" aria-label="Mesaje" aria-rowcount={count + 1} aria-busy={p.loading}>
      <div className="tbl">
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

        {headMode && !p.error && (
          <div role="rowgroup">
            {head.map((r, i) => (
              <Row key={r.id} r={r} i={i} top={0} selected={r.id === p.selectedId} onOpen={p.onOpen} onDevice={p.onDevice} flow />
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
            <h2>Nu a sosit niciun mesaj încă</h2>
            <p style={{ margin: 0 }}>
              Trimite payload-urile ChirpStack la <code>POST /api/ingest</code> cu antetul <code>Authorization: Bearer &lt;INGEST_TOKEN&gt;</code>.
            </p>
          </div>
        )}
        {empty && store && store.n > 0 && (
          <div className="empty">
            <h2>Niciun mesaj pentru filtrele curente</h2>
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
          {Array.from({ length: 9 }, (_, j) => (
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

function Row({ r, i, top, selected, onOpen, onDevice, flow }: { r: RowView; i: number; top: number; selected: boolean; onOpen: (id: string) => void; onDevice: (eui: string) => void; flow?: boolean }) {
  const f = r.fl;
  const hasStatusBadge = (f & (FLAG.BATT | FLAG.OFFLINE | FLAG.BTN | FLAG.MAG)) !== 0;
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
        <div className="mono cell-main" suppressHydrationWarning>
          {fmtTime(r.ts).slice(11)}
        </div>
        <div className="cell-sub mono" suppressHydrationWarning>
          {fmtTime(r.ts).slice(0, 10)}
        </div>
      </div>
      <div role="cell">
        <button
          type="button"
          className="dev-link"
          title={`Filtrează după ${r.dev || r.eui}`}
          onClick={(e) => {
            e.stopPropagation();
            onDevice(r.eui || r.dev);
          }}
        >
          {r.dev || r.eui || "—"}
        </button>
        <div className="cell-sub mono">{r.eui}</div>
      </div>
      <div role="cell">
        <div className="cell-main" title={r.gw ?? undefined}>
          {r.gw ?? "—"}
        </div>
        <div className="cell-sub">{r.gn > 1 ? `${r.gn} gateway-uri` : r.gn === 1 ? "1 gateway" : " "}</div>
      </div>
      <div role="cell">
        <div className="mono cell-main">
          <span className={`sig ${sigClass(r.rssi)}`} aria-hidden="true" />
          {r.rssi != null ? `${r.rssi} dBm` : "—"}
        </div>
        <div className="cell-sub mono">{r.snr != null ? `SNR ${Math.round(r.snr * 10) / 10}` : " "}</div>
      </div>
      <div role="cell">
        <div className="mono cell-main">{r.freqKhz ? `${(r.freqKhz / 1000).toFixed(1)} MHz` : "—"}</div>
        <div className="cell-sub mono">
          {r.dr >= 0 ? `DR${r.dr}` : " "}
          {f & FLAG.ADR ? " · ADR" : ""}
        </div>
      </div>
      <div role="cell">
        <div className="mono cell-main">{r.fc >= 0 ? `#${nf.format(r.fc)}` : "—"}</div>
        <div className="cell-sub mono">{r.pt >= 0 ? `port ${r.pt}` : " "}</div>
      </div>
      <div role="cell">
        {r.types.length === 0 ? (
          <span className="cell-sub">fără decodare</span>
        ) : (
          <div className="badges" title={r.types.join(", ")}>
            <span className="badge type">{r.types[0]}</span>
            {r.types.length > 1 && <span className="badge type">{r.types[1]}</span>}
            {r.types.length > 2 && <span className="badge">+{r.types.length - 2}</span>}
          </div>
        )}
      </div>
      <div role="cell" className="num mono cell-main">
        {r.val != null ? nf.format(r.val) : <span className="cell-sub">—</span>}
      </div>
      <div role="cell">
        <div className="badges">
          {f & FLAG.BATT ? <span className="badge danger">Baterie slabă</span> : null}
          {f & FLAG.OFFLINE ? <span className="badge danger">Offline</span> : null}
          {f & FLAG.BTN ? <span className="badge warn">Buton</span> : null}
          {f & FLAG.MAG ? <span className="badge warn">Magnet</span> : null}
          {!hasStatusBadge && (f & FLAG.STATUS ? <span className="badge ok">OK</span> : <span className="cell-sub">—</span>)}
        </div>
      </div>
    </div>
  );
}

