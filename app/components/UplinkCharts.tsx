"use client";

import { useMemo } from "react";
import {
  FRESH_EDGES, FRESH_LABELS, HEAT_RSSI_MIN, HEAT_RSSI_STEP, HEAT_SNR_MIN, HEAT_SNR_STEP, HEAT_X, HEAT_Y,
  RSSI_BINS, RSSI_MIN, RSSI_STEP, SNR_BINS, SNR_MIN, SNR_STEP, VAL_BINS, type Agg, type AggCtx,
} from "@/lib/uplink-aggregate";
import { toList, toggleIn, type Filters } from "@/lib/uplink-filter";
import type { UplinkStore } from "@/lib/uplink-store";
import { BarList, ChartCard, ColumnChart, Heat, nf, nf1, type Bar, type BarItem } from "./charts/primitives";

const p2 = (n: number) => String(n).padStart(2, "0");
/** ms → valoarea unui <input type="datetime-local"> (ora locală, la minut) */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const WDAYS = ["Lun", "Mar", "Mie", "Joi", "Vin", "Sâm", "Dum"];
const pct = (a: number, b: number) => (b > 0 ? `${nf1.format((a / b) * 100)}%` : "—");
const compact = (v: number) => (v >= 10_000 ? `${nf1.format(v / 1000)}K` : nf.format(Math.round(v)));

type Props = {
  store: UplinkStore;
  filters: Filters;
  patch: (p: Partial<Filters>) => void;
  all: Agg;
  flt: Agg;
  ctx: AggCtx;
  pending: boolean;
};

export default function UplinkCharts({ store, filters, patch, all, flt, ctx, pending }: Props) {
  const d = store.dict;
  const tableOf = (items: { label: string; value: number; ghost: number }[]) => ({
    head: ["", "Filtrate", "Total"],
    rows: items.map((i) => [i.label, i.value, i.ghost]),
  });
  const barsTable = (bars: Bar[]) => tableOf(bars);

  /* ───── liste după dicționar (ordinea vine din TOTAL, nu din filtru: o bară nu se mută când filtrezi) ───── */
  const byDict = (names: string[], f: ArrayLike<number>, a: ArrayLike<number>, label = (s: string) => s): BarItem[] =>
    names
      .map((n, i) => ({ key: n, label: label(n), value: f[i] ?? 0, ghost: a[i] ?? 0 }))
      .filter((x) => x.ghost > 0)
      .sort((x, y) => y.ghost - x.ghost);

  const apps = useMemo(() => byDict(d.ap, flt.apps, all.apps), [d.ap, flt.apps, all.apps]);
  const gws = useMemo(() => byDict(d.gw, flt.gws, all.gws), [d.gw, flt.gws, all.gws]);
  const types = useMemo(() => byDict(d.ty, flt.types, all.types), [d.ty, flt.types, all.types]);
  const models = useMemo(() => byDict(store.models, flt.models, all.models), [store.models, flt.models, all.models]);

  const flagItems: BarItem[] = [
    { key: "offline", label: "Offline", value: flt.flags.offline, ghost: all.flags.offline, tone: "critical", glyph: "✕" },
    { key: "batt", label: "Baterie slabă", value: flt.flags.batt, ghost: all.flags.batt, tone: "serious", glyph: "▲" },
    { key: "button", label: "Buton apăsat", value: flt.flags.button, ghost: all.flags.button, tone: "warning", glyph: "◆" },
    { key: "magnet", label: "Magnet detectat", value: flt.flags.magnet, ghost: all.flags.magnet, tone: "warning", glyph: "◆" },
    { key: "adr", label: "ADR activ", value: flt.flags.adr, ghost: all.flags.adr, tone: "neutral", glyph: "●" },
    { key: "ok", label: "Raport de stare fără alertă", value: flt.flags.statusOk, ghost: all.flags.statusOk, tone: "good", glyph: "✓" },
    { key: "nostatus", label: "Fără raport de stare", value: flt.flags.noStatus, ghost: all.flags.noStatus, tone: "neutral", glyph: "○" },
  ];
  const flagSelected = [...toList(filters.flag), ...(filters.adr === "1" ? ["adr"] : [])];
  const toggleFlag = (k: string) => {
    if (k === "adr") patch({ adr: filters.adr === "1" ? "" : "1" });
    else if (k === "ok" || k === "nostatus") return; // doar informative
    else patch({ flag: toggleIn(filters.flag, k) });
  };

  /* ───── timp ───── */
  const timeBars: Bar[] = useMemo(() => {
    const day = ctx.tStep >= 86_400_000;
    return Array.from({ length: ctx.tN }, (_, i) => {
      const t = new Date(ctx.tStart + i * ctx.tStep);
      const end = new Date(ctx.tStart + (i + 1) * ctx.tStep);
      const hm = (x: Date) => `${p2(x.getHours())}:${p2(x.getMinutes())}`;
      const dm = (x: Date) => `${p2(x.getDate())}.${p2(x.getMonth() + 1)}`;
      return {
        label: day ? dm(t) : `${dm(t)} ${hm(t)} – ${hm(end)}`,
        axis: day ? dm(t) : `${dm(t)} ${hm(t)}`,
        value: flt.time[i] ?? 0,
        ghost: all.time[i] ?? 0,
      };
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

  /* ───── DR / frecvență / port / nr. gateway-uri / an ───── */
  const drLen = Math.max(6, ...Array.from(all.dr).map((v, i) => (v > 0 ? i + 1 : 0)));
  const drBars: Bar[] = Array.from({ length: drLen }, (_, i) => ({ label: `DR${i}`, value: flt.dr[i], ghost: all.dr[i], sub: i === 5 ? "SF7 — cel mai rapid" : i === 0 ? "SF12 — cel mai lent" : undefined }));
  const freqItems: BarItem[] = Array.from(all.freq)
    .map((g, k) => ({ key: String(k * 100), label: `${(k / 10).toFixed(1)} MHz`, value: flt.freq[k], ghost: g }))
    .filter((x) => x.ghost > 0)
    .sort((a, b) => b.ghost - a.ghost);
  const portItems: BarItem[] = Array.from(all.ports)
    .map((g, k) => ({ key: String(k - 1), label: k === 0 ? "necunoscut" : `port ${k - 1}`, value: flt.ports[k], ghost: g }))
    .filter((x, i) => x.ghost > 0 && i > 0)
    .sort((a, b) => b.ghost - a.ghost);
  const gnItems: BarItem[] = [
    { key: "1", label: "1 gateway", value: flt.gn[1], ghost: all.gn[1] },
    { key: "2", label: "2 gateway-uri", value: flt.gn[2], ghost: all.gn[2] },
    { key: "3", label: "3+ gateway-uri", value: flt.gn[3], ghost: all.gn[3] },
  ];
  const yearBars: Bar[] = useMemo(
    () =>
      store.years
        .map((y, i) => ({ y, label: y, value: flt.years[i] ?? 0, ghost: all.years[i] ?? 0 }))
        .filter((x) => x.ghost > 0)
        .sort((a, b) => a.y.localeCompare(b.y)),
    [store.years, flt.years, all.years],
  );

  /* ───── histograme RSSI / SNR / valoare ───── */
  const rssiBars: Bar[] = Array.from({ length: RSSI_BINS }, (_, i) => {
    const lo = RSSI_MIN + i * RSSI_STEP;
    return { label: `${lo} … ${lo + RSSI_STEP} dBm${i === 0 ? " (sau mai slab)" : i === RSSI_BINS - 1 ? " (sau mai tare)" : ""}`, axis: String(lo), value: flt.rssi[i], ghost: all.rssi[i] };
  });
  const snrBars: Bar[] = Array.from({ length: SNR_BINS }, (_, i) => {
    const lo = SNR_MIN + i * SNR_STEP;
    return { label: `${lo} … ${lo + SNR_STEP} dB${i === 0 ? " (sau mai slab)" : i === SNR_BINS - 1 ? " (sau mai tare)" : ""}`, axis: String(lo), value: flt.snr[i], ghost: all.snr[i] };
  });
  const valEdge = (k: number) => ctx.valMax * Math.pow(k / VAL_BINS, 2);
  const valBars: Bar[] = Array.from({ length: VAL_BINS }, (_, i) => ({
    label: `${nf.format(Math.floor(valEdge(i)))} … ${nf.format(Math.ceil(valEdge(i + 1)))}`,
    axis: compact(valEdge(i)),
    value: flt.val[i],
    ghost: all.val[i],
  }));
  const overlap = (lo: number, hi: number, a: string, b: string) => {
    const mn = a === "" ? -Infinity : Number(a), mx = b === "" ? Infinity : Number(b);
    return hi > mn && lo <= mx;
  };
  const rssiOn = filters.rssiMin !== "" || filters.rssiMax !== "";
  const snrOn = filters.snrMin !== "" || filters.snrMax !== "";
  const valOn = filters.valMin !== "" || filters.valMax !== "";

  /* ───── altele ───── */
  const hourBars: Bar[] = Array.from({ length: 24 }, (_, h) => ({ label: `${p2(h)}:00 – ${p2(h)}:59`, axis: p2(h), value: flt.hour[h], ghost: all.hour[h] }));
  const wdayBars: Bar[] = WDAYS.map((w, i) => ({ label: w, value: flt.wday[i], ghost: all.wday[i] }));
  const freshBars: Bar[] = FRESH_LABELS.map((l, i) => ({ label: `Ultimul mesaj ${l}`, axis: l, value: flt.fresh[i], ghost: all.fresh[i] }));
  const freshClick = (i: number) => {
    const to = i === 0 ? "" : toLocalInput(ctx.now - FRESH_EDGES[i]);
    const from = FRESH_EDGES[i + 1] === Infinity ? "" : toLocalInput(ctx.now - FRESH_EDGES[i + 1]);
    patch({ range: "", from, to });
  };
  const topDev: BarItem[] = flt.topDev.map(([di, c]) => ({ key: d.dev[di][1] || d.dev[di][0], label: d.dev[di][0] || d.dev[di][1], value: c, ghost: c }));

  const heatTable = useMemo(() => {
    const cells: [number, number][] = [];
    for (let i = 0; i < flt.heat.length; i++) if (flt.heat[i] > 0) cells.push([i, flt.heat[i]]);
    cells.sort((a, b) => b[1] - a[1]);
    return {
      head: ["Zonă RSSI × SNR (cele mai dese 15)", "Mesaje"],
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
      <div className="kpis" role="group" aria-label="Indicatori pentru rândurile filtrate">
        <Kpi k="Mesaje filtrate" v={nf.format(flt.n)} s={`${pct(flt.n, all.n)} din ${nf.format(all.n)}`} />
        <Kpi k="Dispozitive" v={nf.format(flt.devices)} s={`din ${nf.format(all.devices)}`} />
        <Kpi k="Cu alerte" v={pct(flt.flags.alert, flt.n)} s={`${nf.format(flt.flags.alert)} mesaje`} bad={flt.flags.alert > 0} />
        <Kpi k="RSSI mediu" v={flt.sums.rssiN ? `${avg(flt.sums.rssi, flt.sums.rssiN)} dBm` : "—"} s={`pe ${nf.format(flt.sums.rssiN)} mesaje`} />
        <Kpi k="SNR mediu" v={flt.sums.snrN ? `${avg(flt.sums.snr, flt.sums.snrN)} dB` : "—"} s={`pe ${nf.format(flt.sums.snrN)} mesaje`} />
        <Kpi k="Valoare medie" v={avg(flt.sums.val, flt.sums.valN, 0)} s={`max ${nf.format(Math.round(ctx.valMax))}`} />
        <Kpi k="Gateway-uri / mesaj" v={avg(flt.sums.gn, flt.sums.gnN, 2)} s="medie" />
      </div>
      <p className="legend" aria-hidden="true">
        <span className="sw" /> Filtrate <span className="sw ghost" /> Toate (context) · Click pe o bară filtrează, glisează pe grafic ca să alegi un interval, „Tabel” arată datele.
      </p>

      <div className="grid">
        <ChartCard title="Mesaje în timp" hint={`câte mesaje pe interval de ${stepLabel} — glisează ca să alegi perioada`} span={2} table={barsTable(timeBars)}>
          <ColumnChart bars={timeBars} ariaLabel="Mesaje pe interval de timp" selected={fromMs === fromMs || toMs === toMs ? timeSel : undefined} onBrush={timeBrush} onBar={(i) => timeBrush(i, i)} labelWidth={96} />
        </ChartCard>

        <ChartCard title="Stare și alerte" hint="click pe o stare ca s-o filtrezi" table={tableOf(flagItems)}>
          <BarList items={flagItems} selected={flagSelected} onToggle={toggleFlag} top={8} ariaLabel="Stări ale dispozitivelor" />
        </ChartCard>

        <ChartCard title="Aplicații" table={tableOf(apps)}>
          <BarList items={apps} selected={toList(filters.app)} onToggle={(k) => patch({ app: toggleIn(filters.app, k) })} ariaLabel="Mesaje pe aplicație" />
        </ChartCard>

        <ChartCard title="Gateway-uri" hint="gateway-ul cu semnalul cel mai bun pentru fiecare mesaj" table={tableOf(gws)}>
          <BarList items={gws} selected={toList(filters.gw)} onToggle={(k) => patch({ gw: toggleIn(filters.gw, k) })} ariaLabel="Mesaje pe gateway" />
        </ChartCard>

        <ChartCard title="Tipuri de mesaj" hint="un mesaj poate avea mai multe tipuri" table={tableOf(types)}>
          <BarList items={types} selected={toList(filters.type)} onToggle={(k) => patch({ type: toggleIn(filters.type, k) })} ariaLabel="Mesaje pe tip" />
        </ChartCard>

        <ChartCard title="RSSI (dBm)" hint="puterea semnalului la cel mai bun gateway — glisează pentru interval" table={barsTable(rssiBars)}>
          <ColumnChart
            bars={rssiBars} ariaLabel="Distribuția RSSI" labelWidth={40}
            selected={rssiOn ? (i) => overlap(RSSI_MIN + i * RSSI_STEP, RSSI_MIN + (i + 1) * RSSI_STEP, filters.rssiMin, filters.rssiMax) : undefined}
            onBrush={(a, b) => patch({ rssiMin: String(RSSI_MIN + a * RSSI_STEP), rssiMax: String(RSSI_MIN + (b + 1) * RSSI_STEP) })}
            onBar={(i) => patch({ rssiMin: String(RSSI_MIN + i * RSSI_STEP), rssiMax: String(RSSI_MIN + (i + 1) * RSSI_STEP) })}
          />
        </ChartCard>

        <ChartCard title="SNR (dB)" hint="raportul semnal/zgomot — glisează pentru interval" table={barsTable(snrBars)}>
          <ColumnChart
            bars={snrBars} ariaLabel="Distribuția SNR" labelWidth={40}
            selected={snrOn ? (i) => overlap(SNR_MIN + i * SNR_STEP, SNR_MIN + (i + 1) * SNR_STEP, filters.snrMin, filters.snrMax) : undefined}
            onBrush={(a, b) => patch({ snrMin: String(SNR_MIN + a * SNR_STEP), snrMax: String(SNR_MIN + (b + 1) * SNR_STEP) })}
            onBar={(i) => patch({ snrMin: String(SNR_MIN + i * SNR_STEP), snrMax: String(SNR_MIN + (i + 1) * SNR_STEP) })}
          />
        </ChartCard>

        <ChartCard title="RSSI × SNR" hint="unde se adună mesajele (mai închis = mai multe) — glisează o zonă" table={heatTable}>
          <Heat
            counts={flt.heat} nx={HEAT_X} ny={HEAT_Y} x0={HEAT_RSSI_MIN} xStep={HEAT_RSSI_STEP} y0={HEAT_SNR_MIN} yStep={HEAT_SNR_STEP}
            xLabel="RSSI (dBm)" yLabel="SNR (dB)" ariaLabel="Densitatea mesajelor după RSSI și SNR"
            onBrush={(x0, x1, y0, y1) => patch({ rssiMin: String(x0), rssiMax: String(x1), snrMin: String(y0), snrMax: String(y1) })}
          />
        </ChartCard>

        <ChartCard title="Data rate (DR)" hint="DR0 = SF12 (lent, rază mare) … DR5 = SF7 (rapid)" table={barsTable(drBars)}>
          <ColumnChart
            bars={drBars} ariaLabel="Mesaje pe data rate" labelWidth={30}
            selected={filters.dr ? (i) => toList(filters.dr).includes(String(i)) : undefined}
            onBar={(i) => patch({ dr: toggleIn(filters.dr, String(i)) })}
          />
        </ChartCard>

        <ChartCard title="Frecvențe" table={tableOf(freqItems)}>
          <BarList items={freqItems} selected={toList(filters.fr)} onToggle={(k) => patch({ fr: toggleIn(filters.fr, k) })} ariaLabel="Mesaje pe frecvență" />
        </ChartCard>

        <ChartCard title="fPort" table={tableOf(portItems)}>
          <BarList items={portItems} selected={toList(filters.port)} onToggle={(k) => patch({ port: toggleIn(filters.port, k) })} ariaLabel="Mesaje pe fPort" />
        </ChartCard>

        <ChartCard title="Gateway-uri care au auzit mesajul" hint="redundanța recepției" table={tableOf(gnItems)}>
          <BarList items={gnItems} selected={filters.gn ? [filters.gn] : []} onToggle={(k) => patch({ gn: filters.gn === k ? "" : k })} ariaLabel="Mesaje după numărul de gateway-uri" />
        </ChartCard>

        <ChartCard title="Valoarea din mesaj (citirea)" hint="scală neliniară: intervalele mici sunt mai late — glisează pentru interval" span={2} table={barsTable(valBars)}>
          <ColumnChart
            bars={valBars} ariaLabel="Distribuția valorii citite" labelWidth={52}
            selected={valOn ? (i) => overlap(valEdge(i), valEdge(i + 1), filters.valMin, filters.valMax) : undefined}
            onBrush={(a, b) => patch({ valMin: String(Math.floor(valEdge(a))), valMax: String(Math.ceil(valEdge(b + 1))) })}
            onBar={(i) => patch({ valMin: String(Math.floor(valEdge(i))), valMax: String(Math.ceil(valEdge(i + 1))) })}
          />
        </ChartCard>

        <ChartCard title="Model dispozitiv" hint="din numele dispozitivului (ex. 2154_…)" table={tableOf(models)}>
          <BarList items={models} selected={toList(filters.model)} onToggle={(k) => patch({ model: toggleIn(filters.model, k) })} ariaLabel="Mesaje pe model" />
        </ChartCard>

        <ChartCard title="An de fabricație" hint="ultimele 4 cifre din numele dispozitivului" table={barsTable(yearBars)}>
          <ColumnChart
            bars={yearBars} ariaLabel="Mesaje pe an de fabricație" labelWidth={30}
            selected={filters.year ? (i) => toList(filters.year).includes(yearBars[i].label) : undefined}
            onBar={(i) => patch({ year: toggleIn(filters.year, yearBars[i].label) })}
          />
        </ChartCard>

        <ChartCard title="Activitate pe ore" hint="ora locală a browserului" span={2} table={barsTable(hourBars)}>
          <ColumnChart bars={hourBars} ariaLabel="Mesaje pe ora din zi" labelWidth={26} />
        </ChartCard>

        <ChartCard title="Zile din săptămână" table={barsTable(wdayBars)}>
          <ColumnChart bars={wdayBars} ariaLabel="Mesaje pe zi a săptămânii" labelWidth={40} />
        </ChartCard>

        <ChartCard title="Prospețimea dispozitivelor" hint="câte dispozitive au ultimul mesaj în fiecare interval — click filtrează mesajele din acel interval" span={2} table={barsTable(freshBars)}>
          <ColumnChart bars={freshBars} ariaLabel="Dispozitive după vechimea ultimului mesaj" labelWidth={80} onBar={freshClick} />
        </ChartCard>

        <ChartCard title="Dispozitive cu cele mai multe mesaje" hint="top 10 în rândurile filtrate — click filtrează" table={tableOf(topDev)}>
          <BarList items={topDev} selected={filters.dev ? [filters.dev] : []} onToggle={(k) => patch({ dev: filters.dev === k ? "" : k })} ariaLabel="Top dispozitive" />
        </ChartCard>
      </div>
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
