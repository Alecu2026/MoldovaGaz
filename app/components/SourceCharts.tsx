"use client";

import { useMemo } from "react";
import { EMPTY_LABEL, EMPTY_TOKEN } from "@/lib/source-shared";
import { binsToDays, dictCounts, rangeBounds, setRange, timeAxis, timeCounts, toggleSel, type SFilters } from "@/lib/source-filter";
import type { SourceStore } from "@/lib/source-store";
import { BarList, ChartCard, ColumnChart, nf, type Bar, type BarItem } from "./charts/primitives";
import type { SetF } from "./SourceFilters";

const MONTHS = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "nov", "dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

type Props = { store: SourceStore; filters: SFilters; setF: SetF; idx: Int32Array; pending: boolean; noun: string };

/**
 * Graficele paginilor pe sursă, câte unul pentru fiecare coloană marcată cu `chart`: bare după valoare (dict) sau coloane pe zile / luni / ani (date).
 * Bara plină = rândurile filtrate, bara gri = toate (contextul). Click pe o bară filtrează, glisarea alege un interval, „Tabel” arată datele.
 */
export default function SourceCharts({ store, filters, setF, idx, pending, noun }: Props) {
  const chartCols = useMemo(() => store.cols.filter((c) => c.chart), [store]);
  const all = useMemo(() => Object.fromEntries(chartCols.filter((c) => c.kind === "dict").map((c) => [c.key, dictCounts(store, c.key, null)])), [store, chartCols]);
  const flt = useMemo(() => Object.fromEntries(chartCols.filter((c) => c.kind === "dict").map((c) => [c.key, dictCounts(store, c.key, idx)])), [store, chartCols, idx]);
  const axes = useMemo(() => Object.fromEntries(chartCols.filter((c) => c.kind === "date").map((c) => [c.key, timeAxis(store, c.key)])), [store, chartCols]);
  const timeAll = useMemo(() => Object.fromEntries(chartCols.filter((c) => c.kind === "date" && axes[c.key]).map((c) => [c.key, timeCounts(store, c.key, axes[c.key]!, null)])), [store, chartCols, axes]);
  const timeFlt = useMemo(() => Object.fromEntries(chartCols.filter((c) => c.kind === "date" && axes[c.key]).map((c) => [c.key, timeCounts(store, c.key, axes[c.key]!, idx)])), [store, chartCols, axes, idx]);

  const tableOf = (items: { label: string; value: number; ghost: number }[]) => ({ head: ["", "Filtrate", "Total"], rows: items.map((i) => [i.label, i.value, i.ghost]) });

  return (
    <div className="charts" style={pending ? { opacity: 0.6 } : undefined}>
      <p className="legend" aria-hidden="true">
        <span className="sw" /> Filtrate <span className="sw ghost" /> Toate (context) · Click pe o bară filtrează, glisează pe un grafic cu timp ca să alegi un interval, „Tabel” arată datele.
      </p>
      <div className="grid">
        {chartCols.map((c) => {
          if (c.kind === "dict") {
            const names = store.dict[c.key] ?? [];
            const a = all[c.key], f = flt[c.key];
            const items: BarItem[] = names.map((n, i) => ({ key: n, label: store.label(c, n), value: f[i], ghost: a[i] })).filter((x) => x.ghost > 0).sort((x, y) => y.ghost - x.ghost || x.label.localeCompare(y.label, "ro", { numeric: true }));
            if (a[names.length] > 0) items.push({ key: EMPTY_TOKEN, label: EMPTY_LABEL, value: f[names.length], ghost: a[names.length] });
            return (
              <ChartCard key={c.key} title={c.label} hint={c.hint ?? `${noun}, după valoarea din coloana „${c.label}”`} table={tableOf(items)}>
                <BarList unit={noun} items={items} selected={filters.sel[c.key] ?? []} onToggle={(k) => setF((x) => toggleSel(x, c.key, k))} top={10} ariaLabel={c.label} />
              </ChartCard>
            );
          }
          const ax = axes[c.key];
          if (!ax) return null;
          const A = timeAll[c.key], F = timeFlt[c.key];
          const fmt = (t: number) => {
            const d = new Date(t);
            return ax.unit === "year" ? String(d.getFullYear()) : ax.unit === "month" ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
          };
          const bars: Bar[] = Array.from({ length: ax.n }, (_, i) => ({ label: fmt(ax.start(i)), axis: ax.unit === "day" ? `${p2(new Date(ax.start(i)).getDate())}.${p2(new Date(ax.start(i)).getMonth() + 1)}` : fmt(ax.start(i)), value: F[i], ghost: A[i] }));
          const [lo, hi] = rangeBounds(c, filters.min[c.key], filters.max[c.key]);
          const active = lo === lo || hi === hi;
          const sel = (i: number) => (lo !== lo || ax.start(i + 1) > lo) && (hi !== hi || ax.start(i) <= hi);
          const set = (a: number, b: number) => { const [from, to] = binsToDays(ax, a, b); setF((x) => setRange(x, c.key, from, to)); };
          return (
            <ChartCard key={c.key} title={`${c.label} — pe ${ax.unit === "day" ? "zile" : ax.unit === "month" ? "luni" : "ani"}`} hint={c.hint ?? `câte ${noun} au data în fiecare ${ax.unit === "day" ? "zi" : ax.unit === "month" ? "lună" : "an"} — glisează ca să alegi perioada`} span={2} table={tableOf(bars)}>
              <ColumnChart unit={noun} bars={bars} ariaLabel={c.label} labelWidth={ax.unit === "day" ? 52 : 70} selected={active ? sel : undefined} onBrush={set} onBar={(i) => set(i, i)} />
            </ChartCard>
          );
        })}
        {chartCols.length === 0 && <p className="cell-sub">Nu există coloane pentru grafice.</p>}
      </div>
      <p className="cell-sub" style={{ margin: 0 }}>
        {nf.format(idx.length)} {noun} filtrate din {nf.format(store.n)}.
      </p>
    </div>
  );
}
