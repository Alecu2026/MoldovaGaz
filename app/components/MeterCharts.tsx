"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import {
  BAT_BINS, FRESH_EDGES, FRESH_LABELS, HEAT_RSSI_MIN, HEAT_RSSI_STEP, HEAT_SNR_MIN, HEAT_SNR_STEP, HEAT_X, HEAT_Y,
  RSSI_BINS, RSSI_MIN, RSSI_STEP, SCALE_BINS, SNR_BINS, SNR_MIN, SNR_STEP, type Agg, type AggCtx,
} from "@/lib/meter-aggregate";
import { toList, toggleIn, type Filters } from "@/lib/meter-filter";
import type { MeterStore } from "@/lib/meter-store";
import { BarList, ChartCard, ColumnChart, Heat, nf, nf1, type Bar, type BarItem } from "./charts/primitives";

/** Graficele pe antene (filtre proprii) se încarcă doar în fila „Grafice”. */
const GatewayCharts = dynamic(() => import("./GatewayCharts"), { ssr: false, loading: () => <div className="skeleton" style={{ height: 240, marginTop: 12 }} /> });

const p2 = (n: number) => String(n).padStart(2, "0");
/** ms → valoarea unui <input type="datetime-local"> (ora locală, la minut) */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const WDAYS = ["Lun", "Mar", "Mie", "Joi", "Vin", "Sâm", "Dum"];
const pct = (a: number, b: number) => (b > 0 ? `${nf1.format((a / b) * 100)}%` : "—");
const compact = (v: number) => (v >= 10_000 ? `${nf1.format(v / 1000)}K` : nf.format(Math.round(v)));

type Props = { store: MeterStore; filters: Filters; patch: (p: Partial<Filters>) => void; all: Agg; flt: Agg; ctx: AggCtx; pending: boolean; onOpenMeter?: (id: string) => void };

export default function MeterCharts({ store, filters, patch, all, flt, ctx, pending, onOpenMeter }: Props) {
  const d = store.dict;
  const tableOf = (items: { label: string; value: number; ghost: number }[]) => ({ head: ["", "Filtrate", "Total"], rows: items.map((i) => [i.label, i.value, i.ghost]) });
  const barsTable = (bars: Bar[]) => tableOf(bars);

  /* ───── liste după dicționar (ordinea vine din TOTAL, nu din filtru: o bară nu se mută când filtrezi) ───── */
  const byDict = (names: string[], f: ArrayLike<number>, a: ArrayLike<number>): BarItem[] =>
    names.map((n, i) => ({ key: n, label: n, value: f[i] ?? 0, ghost: a[i] ?? 0 })).filter((x) => x.ghost > 0).sort((x, y) => y.ghost - x.ghost);

  const branches = useMemo(() => byDict(d.br, flt.brs, all.brs), [d.br, flt.brs, all.brs]);
  const brVolume = useMemo(
    () => d.br.map((n, i) => ({ key: n, label: n, value: Math.round(flt.brVol[i]), ghost: Math.round(all.brVol[i]) })).filter((x) => x.ghost > 0).sort((x, y) => y.ghost - x.ghost),
    [d.br, flt.brVol, all.brVol],
  );
  const cities = useMemo(() => byDict(d.ct, flt.cts, all.cts), [d.ct, flt.cts, all.cts]);
  const profiles = useMemo(() => byDict(d.pf, flt.pfs, all.pfs), [d.pf, flt.pfs, all.pfs]);
  const apps = useMemo(() => byDict(d.ap, flt.apps, all.apps), [d.ap, flt.apps, all.apps]);
  const gws = useMemo(() => byDict(d.gw, flt.gws, all.gws), [d.gw, flt.gws, all.gws]);
  const types = useMemo(() => byDict(d.ty, flt.types, all.types), [d.ty, flt.types, all.types]);
  const models = useMemo(() => byDict(store.models, flt.models, all.models), [store.models, flt.models, all.models]);

  const flagItems: BarItem[] = [
    { key: "act", label: "Activ (citire în ultimele 24 h)", value: flt.flags.act, ghost: all.flags.act, tone: "good", glyph: "✓" },
    { key: "warn", label: "Avertizare (1–7 zile fără citire)", value: flt.flags.warn, ghost: all.flags.warn, tone: "warning", glyph: "◆" },
    { key: "crit", label: "Critic (peste 7 zile fără citire)", value: flt.flags.crit, ghost: all.flags.crit, tone: "critical", glyph: "✕" },
    { key: "noact", label: "Fără nicio citire", value: flt.flags.noact, ghost: all.flags.noact, tone: "neutral", glyph: "○" },
    { key: "active", label: "Marcat activ în SCADA (active = true)", value: flt.flags.active, ghost: all.flags.active, tone: "good", glyph: "✓" },
    { key: "batt", label: "Baterie slabă", value: flt.flags.batt, ghost: all.flags.batt, tone: "serious", glyph: "▲" },
    { key: "inactive", label: "Inactiv în SCADA (alertă)", value: flt.flags.inactive, ghost: all.flags.inactive, tone: "critical", glyph: "✕" },
    { key: "dup", label: "Serie repetată (același număr radio)", value: flt.flags.dup, ghost: all.flags.dup, tone: "warning", glyph: "◆" },
    { key: "button", label: "Buton apăsat", value: flt.flags.button, ghost: all.flags.button, tone: "warning", glyph: "◆" },
    { key: "magnet", label: "Magnet detectat", value: flt.flags.magnet, ghost: all.flags.magnet, tone: "warning", glyph: "◆" },
    { key: "ok", label: "OK (raport de stare fără probleme)", value: flt.flags.statusOk, ghost: all.flags.statusOk, tone: "good", glyph: "✓" },
    { key: "nostatus", label: "Fără raport de stare", value: flt.flags.noStatus, ghost: all.flags.noStatus, tone: "neutral", glyph: "○" },
    { key: "billed", label: "Cu rând în facturare", value: flt.flags.billed, ghost: all.flags.billed, tone: "neutral", glyph: "●" },
    { key: "unbilled", label: "Fără facturare", value: flt.flags.noBilled, ghost: all.flags.noBilled, tone: "neutral", glyph: "○" },
  ];
  const flagSelected = [...toList(filters.flag), ...(filters.billed === "1" ? ["billed"] : filters.billed === "0" ? ["unbilled"] : [])];
  const toggleFlag = (k: string) => {
    if (k === "billed") patch({ billed: filters.billed === "1" ? "" : "1" });
    else if (k === "unbilled") patch({ billed: filters.billed === "0" ? "" : "0" });
    else patch({ flag: toggleIn(filters.flag, k) });
  };

  /* ───── timp (ultima citire) ───── */
  const timeBars: Bar[] = useMemo(() => {
    const day = ctx.tStep >= 86_400_000;
    return Array.from({ length: ctx.tN }, (_, i) => {
      const t = new Date(ctx.tStart + i * ctx.tStep);
      const end = new Date(ctx.tStart + (i + 1) * ctx.tStep);
      const hm = (x: Date) => `${p2(x.getHours())}:${p2(x.getMinutes())}`;
      const dm = (x: Date) => `${p2(x.getDate())}.${p2(x.getMonth() + 1)}`;
      return { label: day ? dm(t) : `${dm(t)} ${hm(t)} – ${hm(end)}`, axis: day ? dm(t) : `${dm(t)} ${hm(t)}`, value: flt.time[i] ?? 0, ghost: all.time[i] ?? 0 };
    });
  }, [ctx, flt.time, all.time]);
  const stepLabel = ctx.tStep >= 86_400_000 ? `${ctx.tStep / 86_400_000} zi` : ctx.tStep >= 3_600_000 ? `${ctx.tStep / 3_600_000} h` : `${ctx.tStep / 60_000} min`;
  const fromMs = filters.from ? Date.parse(filters.from) : NaN;
  const toMs = filters.to ? Date.parse(filters.to) : NaN;
  const timeSel = (i: number) => {
    const a = ctx.tStart + i * ctx.tStep, b = a + ctx.tStep;
    return (fromMs !== fromMs || b > fromMs) && (toMs !== toMs || a <= toMs);
  };
  const timeBrush = (a: number, b: number) => patch({ range: "", from: toLocalInput(ctx.tStart + a * ctx.tStep), to: toLocalInput(ctx.tStart + (b + 1) * ctx.tStep) });

  const freqItems: BarItem[] = Array.from(all.freq).map((g, k) => ({ key: String(k * 100), label: k === 0 ? "necunoscută" : `${(k / 10).toFixed(1)} MHz`, value: flt.freq[k], ghost: g })).filter((x) => x.ghost > 0).sort((a, b) => b.ghost - a.ghost);
  const portItems: BarItem[] = Array.from(all.ports).map((g, k) => ({ key: String(k - 1), label: `port ${k - 1}`, value: flt.ports[k], ghost: g })).filter((x, i) => x.ghost > 0 && i > 0).sort((a, b) => b.ghost - a.ghost);
  const yearBars: Bar[] = useMemo(
    () => store.years.map((y, i) => ({ y, label: y, value: flt.years[i] ?? 0, ghost: all.years[i] ?? 0 })).filter((x) => x.ghost > 0).sort((a, b) => a.y.localeCompare(b.y)),
    [store.years, flt.years, all.years],
  );

  /* ───── histograme ───── */
  const rssiBars: Bar[] = Array.from({ length: RSSI_BINS }, (_, i) => {
    const lo = RSSI_MIN + i * RSSI_STEP;
    return { label: `${lo} … ${lo + RSSI_STEP} dBm${i === 0 ? " (sau mai slab)" : i === RSSI_BINS - 1 ? " (sau mai tare)" : ""}`, axis: String(lo), value: flt.rssi[i], ghost: all.rssi[i] };
  });
  const snrBars: Bar[] = Array.from({ length: SNR_BINS }, (_, i) => {
    const lo = SNR_MIN + i * SNR_STEP;
    return { label: `${lo} … ${lo + SNR_STEP} dB${i === 0 ? " (sau mai slab)" : i === SNR_BINS - 1 ? " (sau mai tare)" : ""}`, axis: String(lo), value: flt.snr[i], ghost: all.snr[i] };
  });
  const batBars: Bar[] = Array.from({ length: BAT_BINS }, (_, i) => ({ label: `${i * 10} … ${(i + 1) * 10}%`, axis: String(i * 10), value: flt.bat[i], ghost: all.bat[i] }));
  const edge = (max: number, k: number) => max * Math.pow(k / SCALE_BINS, 2);
  const rng = (max: number, i: number, unit: string) => (i === SCALE_BINS - 1 ? `${nf.format(Math.floor(edge(max, i)))} ${unit} sau mai mult` : `${nf.format(Math.floor(edge(max, i)))} … ${nf.format(Math.ceil(edge(max, i + 1)))} ${unit}`);
  /** limita de sus a unei bare; ultima bară nu are limită (strânge și valorile aberante) */
  const hi = (max: number, i: number) => (i === SCALE_BINS - 1 ? "" : String(Math.ceil(edge(max, i + 1))));
  const valBars: Bar[] = Array.from({ length: SCALE_BINS }, (_, i) => ({ label: rng(ctx.valMax, i, "m³"), axis: compact(edge(ctx.valMax, i)), value: flt.val[i], ghost: all.val[i] }));
  const dcBars: Bar[] = Array.from({ length: SCALE_BINS }, (_, i) => ({ label: rng(ctx.dcMax, i, "L"), axis: compact(edge(ctx.dcMax, i)), value: flt.dc[i], ghost: all.dc[i] }));
  const overlap = (lo: number, hi: number, a: string, b: string) => {
    const mn = a === "" ? -Infinity : Number(a), mx = b === "" ? Infinity : Number(b);
    return hi > mn && lo <= mx;
  };
  const on = (a: string, b: string) => a !== "" || b !== "";

  /* ───── altele ───── */
  const hourBars: Bar[] = Array.from({ length: 24 }, (_, h) => ({ label: `${p2(h)}:00 – ${p2(h)}:59`, axis: p2(h), value: flt.hour[h], ghost: all.hour[h] }));
  const wdayBars: Bar[] = WDAYS.map((w, i) => ({ label: w, value: flt.wday[i], ghost: all.wday[i] }));
  const freshBars: Bar[] = FRESH_LABELS.map((l, i) => ({ label: i === 6 ? "Fără nicio citire" : `Ultima citire ${l}`, axis: l, value: flt.fresh[i], ghost: all.fresh[i] }));
  const freshClick = (i: number) => {
    if (i === 6) return; // „niciodată” nu se poate exprima ca interval de timp
    const to = i === 0 ? "" : toLocalInput(ctx.now - FRESH_EDGES[i]);
    const from = FRESH_EDGES[i + 1] === Infinity ? "" : toLocalInput(ctx.now - FRESH_EDGES[i + 1]);
    patch({ range: "", from, to });
  };
  const topDc: BarItem[] = flt.topDc.map(([i, v]) => ({ key: store.id[i], label: store.nm[i], value: v, ghost: v, sub: store.dict.br[store.br[i]] }));

  const heatTable = useMemo(() => {
    const cells: [number, number][] = [];
    for (let i = 0; i < flt.heat.length; i++) if (flt.heat[i] > 0) cells.push([i, flt.heat[i]]);
    cells.sort((a, b) => b[1] - a[1]);
    return {
      head: ["Zonă RSSI × SNR (cele mai dese 15)", "Contoare"],
      rows: cells.slice(0, 15).map(([i, c]) => {
        const x = i % HEAT_X, y = Math.floor(i / HEAT_X);
        const r = HEAT_RSSI_MIN + x * HEAT_RSSI_STEP, s = HEAT_SNR_MIN + y * HEAT_SNR_STEP;
        return [`RSSI ${r} … ${r + HEAT_RSSI_STEP} dBm · SNR ${s} … ${s + HEAT_SNR_STEP} dB`, c] as [string, number];
      }),
    };
  }, [flt.heat]);

  const avg = (s: number, n: number, digits = 1) => (n > 0 ? nf1.format(Math.round((s / n) * 10 ** digits) / 10 ** digits) : "—");

  return (
    <div className="charts" style={pending ? { opacity: 0.6 } : undefined} aria-busy={pending}>
      <div className="kpis" role="group" aria-label="Indicatori pentru contoarele filtrate">
        <Kpi k="Contoare filtrate" v={nf.format(flt.n)} s={`${pct(flt.n, all.n)} din ${nf.format(all.n)}`} />
        <Kpi k="Volum total" v={`${nf.format(Math.round(flt.sums.val))} m³`} s={`pe ${nf.format(flt.sums.valN)} contoare cu citire`} />
        <Kpi k="Cu alerte" v={pct(flt.flags.alert, flt.n)} s={`${nf.format(flt.flags.alert)} contoare`} bad={flt.flags.alert > 0} />
        <Kpi k="Consum zilnic mediu" v={flt.sums.dcN ? `${avg(flt.sums.dc, flt.sums.dcN, 0)} L` : "—"} s={`pe ${nf.format(flt.sums.dcN)} contoare`} />
        <Kpi k="Baterie medie" v={flt.sums.batN ? `${avg(flt.sums.bat, flt.sums.batN)}%` : "—"} s={`pe ${nf.format(flt.sums.batN)} contoare`} />
        <Kpi k="RSSI mediu" v={flt.sums.rssiN ? `${avg(flt.sums.rssi, flt.sums.rssiN)} dBm` : "—"} s={`pe ${nf.format(flt.sums.rssiN)} contoare`} />
        <Kpi k="SNR mediu" v={flt.sums.snrN ? `${avg(flt.sums.snr, flt.sums.snrN)} dB` : "—"} s={`pe ${nf.format(flt.sums.snrN)} contoare`} />
      </div>
      <p className="legend" aria-hidden="true">
        <span className="sw" /> Filtrate <span className="sw ghost" /> Toate (context) · Click pe o bară filtrează, glisează pe grafic ca să alegi un interval, „Tabel” arată datele.
      </p>

      <div className="grid">
        <ChartCard title="Contoare după ultima citire" hint={`câte contoare au ultima citire în fiecare interval de ${stepLabel} — glisează ca să alegi perioada`} span={2} table={barsTable(timeBars)}>
          <ColumnChart unit="contoare" bars={timeBars} ariaLabel="Contoare după momentul ultimei citiri" selected={fromMs === fromMs || toMs === toMs ? timeSel : undefined} onBrush={timeBrush} onBar={(i) => timeBrush(i, i)} labelWidth={96} />
        </ChartCard>

        <ChartCard title="Stare și alerte" hint="activitatea (după momentul ultimei citiri de volum) ca în SCADA. Click filtrează (SAU)" table={tableOf(flagItems)}>
          <BarList unit="contoare" items={flagItems} selected={flagSelected} onToggle={toggleFlag} top={14} ariaLabel="Stări ale contoarelor" />
        </ChartCard>

        <ChartCard title="Contoare pe filială" hint="filiala din facturare (FIL), altfel din clientul SCADA" table={tableOf(branches)}>
          <BarList unit="contoare" items={branches} selected={toList(filters.branch)} onToggle={(k) => patch({ branch: toggleIn(filters.branch, k) })} top={12} ariaLabel="Contoare pe filială" />
        </ChartCard>

        <ChartCard title="Volum total pe filială (m³)" hint="suma ultimelor citiri Volume_m3_Total (valorile negative sunt ignorate)" table={tableOf(brVolume)}>
          <BarList unit="m³" items={brVolume} selected={toList(filters.branch)} onToggle={(k) => patch({ branch: toggleIn(filters.branch, k) })} top={12} ariaLabel="Volum total pe filială" />
        </ChartCard>

        <ChartCard title="Orașe / localități" table={tableOf(cities)}>
          <BarList unit="contoare" items={cities} selected={toList(filters.city)} onToggle={(k) => patch({ city: toggleIn(filters.city, k) })} ariaLabel="Contoare pe oraș" />
        </ChartCard>

        <ChartCard title="Profil contor" hint="profilul de dispozitiv din SCADA" table={tableOf(profiles)}>
          <BarList unit="contoare" items={profiles} selected={toList(filters.profile)} onToggle={(k) => patch({ profile: toggleIn(filters.profile, k) })} top={12} ariaLabel="Contoare pe profil" />
        </ChartCard>

        <ChartCard title="Aplicații" table={tableOf(apps)}>
          <BarList unit="contoare" items={apps} selected={toList(filters.app)} onToggle={(k) => patch({ app: toggleIn(filters.app, k) })} ariaLabel="Contoare pe aplicație" />
        </ChartCard>

        <ChartCard title="Concentratoare (gateway)" hint="ultimul concentrator care a auzit contorul" table={tableOf(gws)}>
          <BarList unit="contoare" items={gws} selected={toList(filters.gw)} onToggle={(k) => patch({ gw: toggleIn(filters.gw, k) })} ariaLabel="Contoare pe concentrator" />
        </ChartCard>

        <ChartCard title="Tipuri de mesaj" hint="ultimul tip de mesaj primit (ieType)" table={tableOf(types)}>
          <BarList unit="contoare" items={types} selected={toList(filters.type)} onToggle={(k) => patch({ type: toggleIn(filters.type, k) })} ariaLabel="Contoare pe tip de mesaj" />
        </ChartCard>

        <ChartCard title="Volume (m³)" hint="ultima citire Volume_m3_Total; scală neliniară — glisează pentru interval" span={2} table={barsTable(valBars)}>
          <ColumnChart
            unit="contoare"
            bars={valBars} ariaLabel="Distribuția volumului citit" labelWidth={52}
            selected={on(filters.valMin, filters.valMax) ? (i) => overlap(edge(ctx.valMax, i), edge(ctx.valMax, i + 1), filters.valMin, filters.valMax) : undefined}
            onBrush={(a, b) => patch({ valMin: String(Math.floor(edge(ctx.valMax, a))), valMax: hi(ctx.valMax, b) })}
            onBar={(i) => patch({ valMin: String(Math.floor(edge(ctx.valMax, i))), valMax: hi(ctx.valMax, i) })}
          />
          <p className="cell-sub" style={{ margin: "4px 0 0" }}>{nf.format(flt.valNone)} contoare fără citire sau cu valoare negativă nu apar în grafic.</p>
        </ChartCard>

        <ChartCard title="Consum zilnic (L)" hint="dailyConsumption din SCADA — glisează pentru interval" table={barsTable(dcBars)}>
          <ColumnChart
            unit="contoare"
            bars={dcBars} ariaLabel="Distribuția consumului zilnic" labelWidth={46}
            selected={on(filters.dcMin, filters.dcMax) ? (i) => overlap(edge(ctx.dcMax, i), edge(ctx.dcMax, i + 1), filters.dcMin, filters.dcMax) : undefined}
            onBrush={(a, b) => patch({ dcMin: String(Math.floor(edge(ctx.dcMax, a))), dcMax: hi(ctx.dcMax, b) })}
            onBar={(i) => patch({ dcMin: String(Math.floor(edge(ctx.dcMax, i))), dcMax: hi(ctx.dcMax, i) })}
          />
        </ChartCard>

        <ChartCard title="Baterie (%)" hint="capacitatea rămasă — glisează pentru interval" table={barsTable(batBars)}>
          <ColumnChart
            unit="contoare"
            bars={batBars} ariaLabel="Distribuția bateriei" labelWidth={26}
            selected={on(filters.batMin, filters.batMax) ? (i) => overlap(i * 10, (i + 1) * 10, filters.batMin, filters.batMax) : undefined}
            onBrush={(a, b) => patch({ batMin: String(a * 10), batMax: String((b + 1) * 10) })}
            onBar={(i) => patch({ batMin: String(i * 10), batMax: String((i + 1) * 10) })}
          />
        </ChartCard>

        <ChartCard title="RSSI (dBm)" hint="puterea semnalului — glisează pentru interval" table={barsTable(rssiBars)}>
          <ColumnChart
            unit="contoare"
            bars={rssiBars} ariaLabel="Distribuția RSSI" labelWidth={40}
            selected={on(filters.rssiMin, filters.rssiMax) ? (i) => overlap(RSSI_MIN + i * RSSI_STEP, RSSI_MIN + (i + 1) * RSSI_STEP, filters.rssiMin, filters.rssiMax) : undefined}
            onBrush={(a, b) => patch({ rssiMin: String(RSSI_MIN + a * RSSI_STEP), rssiMax: String(RSSI_MIN + (b + 1) * RSSI_STEP) })}
            onBar={(i) => patch({ rssiMin: String(RSSI_MIN + i * RSSI_STEP), rssiMax: String(RSSI_MIN + (i + 1) * RSSI_STEP) })}
          />
        </ChartCard>

        <ChartCard title="SNR (dB)" hint="raportul semnal/zgomot — glisează pentru interval" table={barsTable(snrBars)}>
          <ColumnChart
            unit="contoare"
            bars={snrBars} ariaLabel="Distribuția SNR" labelWidth={40}
            selected={on(filters.snrMin, filters.snrMax) ? (i) => overlap(SNR_MIN + i * SNR_STEP, SNR_MIN + (i + 1) * SNR_STEP, filters.snrMin, filters.snrMax) : undefined}
            onBrush={(a, b) => patch({ snrMin: String(SNR_MIN + a * SNR_STEP), snrMax: String(SNR_MIN + (b + 1) * SNR_STEP) })}
            onBar={(i) => patch({ snrMin: String(SNR_MIN + i * SNR_STEP), snrMax: String(SNR_MIN + (i + 1) * SNR_STEP) })}
          />
        </ChartCard>

        <ChartCard title="RSSI × SNR" hint="unde se adună contoarele (mai închis = mai multe) — glisează o zonă" table={heatTable}>
          <Heat
            counts={flt.heat} nx={HEAT_X} ny={HEAT_Y} x0={HEAT_RSSI_MIN} xStep={HEAT_RSSI_STEP} y0={HEAT_SNR_MIN} yStep={HEAT_SNR_STEP}
            xLabel="RSSI (dBm)" yLabel="SNR (dB)" ariaLabel="Densitatea contoarelor după RSSI și SNR"
            onBrush={(x0, x1, y0, y1) => patch({ rssiMin: String(x0), rssiMax: String(x1), snrMin: String(y0), snrMax: String(y1) })}
          />
        </ChartCard>

        <ChartCard title="Frecvențe" table={tableOf(freqItems)}>
          <BarList unit="contoare" items={freqItems} selected={toList(filters.fr)} onToggle={(k) => patch({ fr: toggleIn(filters.fr, k) })} ariaLabel="Contoare pe frecvență" />
        </ChartCard>

        <ChartCard title="fPort" table={tableOf(portItems)}>
          <BarList unit="contoare" items={portItems} selected={toList(filters.port)} onToggle={(k) => patch({ port: toggleIn(filters.port, k) })} ariaLabel="Contoare pe fPort" />
        </ChartCard>

        <ChartCard title="Model contor" hint="din numele dispozitivului (ex. S2154_…)" table={tableOf(models)}>
          <BarList unit="contoare" items={models} selected={toList(filters.model)} onToggle={(k) => patch({ model: toggleIn(filters.model, k) })} ariaLabel="Contoare pe model" />
        </ChartCard>

        <ChartCard title="An / cod lot" hint="ultimele 4 cifre din numele dispozitivului (an la modelele vechi, cod de lot la cele noi)" table={barsTable(yearBars)}>
          <ColumnChart
            unit="contoare"
            bars={yearBars} ariaLabel="Contoare pe an de fabricație" labelWidth={30}
            selected={filters.year ? (i) => toList(filters.year).includes(yearBars[i].label) : undefined}
            onBar={(i) => patch({ year: toggleIn(filters.year, yearBars[i].label) })}
          />
        </ChartCard>

        <ChartCard title="Ora ultimei citiri" hint="ora locală a browserului" span={2} table={barsTable(hourBars)}>
          <ColumnChart unit="contoare" bars={hourBars} ariaLabel="Contoare după ora ultimei citiri" labelWidth={26} />
        </ChartCard>

        <ChartCard title="Ziua ultimei citiri" table={barsTable(wdayBars)}>
          <ColumnChart unit="contoare" bars={wdayBars} ariaLabel="Contoare după ziua săptămânii" labelWidth={40} />
        </ChartCard>

        <ChartCard title="Prospețimea citirilor" hint="vechimea ultimei citiri — click filtrează contoarele din acel interval" span={2} table={barsTable(freshBars)}>
          <ColumnChart unit="contoare" bars={freshBars} ariaLabel="Contoare după vechimea ultimei citiri" labelWidth={70} onBar={freshClick} />
        </ChartCard>

        <ChartCard title="Cele mai mari consumuri zilnice" hint="top 10 contoare din rândurile filtrate, în litri — click filtrează contorul" table={tableOf(topDc)}>
          <BarList unit="L" items={topDc} selected={filters.dev ? [filters.dev] : []} onToggle={(k) => patch({ dev: filters.dev === k ? "" : k })} ariaLabel="Top consum zilnic" />
        </ChartCard>
      </div>

      <GatewayCharts onOpenMeter={onOpenMeter} />
    </div>
  );
}

function Kpi({ k, v, s, bad }: { k: string; v: string; s: string; bad?: boolean }) {
  return (
    <div className={`stat ${bad ? "alert" : ""}`}>
      <div className="k">{k}</div>
      <div className="v" style={{ fontSize: 20 }}>{v}</div>
      <div className="s">{s}</div>
    </div>
  );
}
