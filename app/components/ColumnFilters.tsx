"use client";

import type { Agg } from "@/lib/meter-aggregate";
import { FLAG_LABELS, fromList, toList, type Filters } from "@/lib/meter-filter";
import type { MeterStore } from "@/lib/meter-store";
import { MultiSelect, type Opt } from "./FilterPanel";

/**
 * Filtrele din antetul tabelului: câte unul chiar sub numele fiecărei coloane. Folosesc ACEEAȘI stare ca bara de filtre de sus
 * (aceleași câmpuri din `Filters`), deci o schimbare făcută într-un loc apare și în celălalt, în URL și în etichetele filtrelor active.
 */
export type ColKey = "ts" | "dev" | "br" | "ct" | "gw" | "rssi" | "bat" | "val" | "dc" | "ty" | "st";

type P = { col: ColKey; store: MeterStore | null; all: Agg | null; filters: Filters; patch: (p: Partial<Filters>) => void };

/** Numele din dicționar, cele mai numeroase primele, cu numărătoarea din TOATE rândurile (nu se schimbă cât filtrezi). */
const named = (names: string[], counts: ArrayLike<number> | undefined, sort: "count" | "name" = "count"): Opt[] => {
  const o = names.map((n, i) => ({ value: n, count: counts?.[i] })).filter((x) => x.value);
  return o.sort((a, b) => (sort === "name" ? a.value.localeCompare(b.value, "ro", { numeric: true }) : (b.count ?? 0) - (a.count ?? 0) || a.value.localeCompare(b.value)));
};

function Range({ label, min, max, onMin, onMax, step }: { label: string; min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void; step?: string }) {
  return (
    <div className="cf-range" role="group" aria-label={label}>
      <input className="input cf-in" type="number" inputMode="decimal" step={step} placeholder="de la" value={min} onChange={(e) => onMin(e.target.value)} aria-label={`${label}, minim`} />
      <input className="input cf-in" type="number" inputMode="decimal" step={step} placeholder="până la" value={max} onChange={(e) => onMax(e.target.value)} aria-label={`${label}, maxim`} />
    </div>
  );
}

const STATES = (all: Agg | null): Opt[] => [
  { value: "alert", label: FLAG_LABELS.alert, count: all?.flags.alert },
  { value: "offline", label: FLAG_LABELS.offline, count: all?.flags.offline },
  { value: "batt", label: FLAG_LABELS.batt, count: all?.flags.batt },
  { value: "inactive", label: FLAG_LABELS.inactive, count: all?.flags.inactive },
  { value: "dup", label: FLAG_LABELS.dup, count: all?.flags.dup },
  { value: "button", label: FLAG_LABELS.button, count: all?.flags.button },
  { value: "magnet", label: FLAG_LABELS.magnet, count: all?.flags.magnet },
];

export default function ColumnFilter({ col, store, all, filters: f, patch }: P) {
  const d = store?.dict;
  switch (col) {
    case "ts":
      return (
        <select className="select cf-in" aria-label="Ultima citire" value={f.from || f.to ? "custom" : f.range} onChange={(e) => e.target.value !== "custom" && patch({ range: e.target.value, from: "", to: "" })}>
          <option value="">Oricând</option>
          <option value="1h">Ultima oră</option>
          <option value="24h">Ultimele 24 ore</option>
          <option value="7d">Ultimele 7 zile</option>
          <option value="30d">Ultimele 30 zile</option>
          {(f.from || f.to) && <option value="custom">Interval ales</option>}
        </select>
      );
    case "dev":
      return <input className="input cf-in" type="search" placeholder="nume sau devEUI" aria-label="Contor: nume sau devEUI" value={f.name} onChange={(e) => patch({ name: e.target.value })} autoComplete="off" spellCheck={false} />;
    case "br":
      return <MultiSelect compact label="Filială" options={named(d?.br ?? [], all?.brs, "name")} selected={toList(f.branch)} onChange={(v) => patch({ branch: fromList(v) })} />;
    case "ct":
      return <MultiSelect compact label="Oraș" options={named(d?.ct ?? [], all?.cts)} selected={toList(f.city)} onChange={(v) => patch({ city: fromList(v) })} />;
    case "gw":
      return <MultiSelect compact label="Concentrator" options={named(d?.gw ?? [], all?.gws)} selected={toList(f.gw)} onChange={(v) => patch({ gw: fromList(v) })} />;
    case "rssi":
      return <Range label="RSSI (dBm)" min={f.rssiMin} max={f.rssiMax} onMin={(v) => patch({ rssiMin: v })} onMax={(v) => patch({ rssiMax: v })} />;
    case "bat":
      return <Range label="Baterie (%)" min={f.batMin} max={f.batMax} onMin={(v) => patch({ batMin: v })} onMax={(v) => patch({ batMax: v })} />;
    case "val":
      return <Range label="Volume (m³)" min={f.valMin} max={f.valMax} onMin={(v) => patch({ valMin: v })} onMax={(v) => patch({ valMax: v })} />;
    case "dc":
      return <Range label="Consum zilnic (L)" min={f.dcMin} max={f.dcMax} onMin={(v) => patch({ dcMin: v })} onMax={(v) => patch({ dcMax: v })} />;
    case "ty":
      return <MultiSelect compact align="right" label="Tip mesaj" options={named(d?.ty ?? [], all?.types)} selected={toList(f.type)} onChange={(v) => patch({ type: fromList(v) })} />;
    case "st":
      return <MultiSelect compact align="right" label="Stare" options={STATES(all)} selected={toList(f.flag)} onChange={(v) => patch({ flag: fromList(v) })} />;
  }
}
