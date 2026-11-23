"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Agg } from "@/lib/meter-aggregate";
import { FLAG_LABELS, describeFilters, fromList, toList, type Filters } from "@/lib/meter-filter";
import type { MeterStore } from "@/lib/meter-store";
import { nf } from "./charts/primitives";

export type Opt = { value: string; label?: string; count?: number };

/** Listă derulantă cu bife (mai multe valori, SAU între ele) și căutare când sunt multe opțiuni. */
export function MultiSelect({ label, options, selected, onChange, compact, align }: { label: string; options: Opt[]; selected: string[]; onChange: (v: string[]) => void; /** în antetul tabelului: fără etichetă vizibilă, buton mic */ compact?: boolean; /** lângă ce margine se deschide lista */ align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const known = new Set(options.map((o) => o.value));
  const all: Opt[] = [...selected.filter((s) => !known.has(s)).map((s): Opt => ({ value: s })), ...options]; // valoarea din URL apare și cât timp lista încă se încarcă
  const shown = (q ? all.filter((o) => (o.label ?? o.value).toLowerCase().includes(q.toLowerCase())) : all).slice(0, 300);
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const summary = selected.length === 0 ? "Toate" : selected.length === 1 ? labelOf(selected[0]) : `${selected.length} selectate`;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div className={`field ms ${compact ? "ms-compact" : ""} ${align === "right" ? "ms-right" : ""}`} ref={ref}>
      <span id={id} className={compact ? "sr-only" : undefined}>{label}</span>
      <button type="button" className={`select ms-btn ${selected.length ? "on" : ""}`} aria-haspopup="listbox" aria-expanded={open} aria-labelledby={id} onClick={() => setOpen((v) => !v)}>
        <span className="ms-sum">{summary}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="ms-pop" role="listbox" aria-multiselectable="true" aria-labelledby={id}>
          {all.length > 8 && <input className="input" type="search" placeholder="Caută…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus style={{ marginBottom: 6 }} />}
          <div className="ms-list">
            {shown.map((o) => {
              const on = selected.includes(o.value);
              return (
                <label key={o.value} className={`ms-opt ${on ? "on" : ""}`} role="option" aria-selected={on}>
                  <input type="checkbox" checked={on} onChange={() => toggle(o.value)} />
                  <span className="ms-ol">{o.label ?? o.value}</span>
                  {o.count != null && <span className="ms-c mono">{nf.format(o.count)}</span>}
                </label>
              );
            })}
            {shown.length === 0 && <div className="cell-sub" style={{ padding: 8 }}>Nicio potrivire.</div>}
          </div>
          <div className="ms-foot">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([])} disabled={selected.length === 0}>
              Golește
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
              Gata
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Range({ label, unit, min, max, onMin, onMax }: { label: string; unit?: string; min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void }) {
  return (
    <fieldset className="range">
      <legend>
        {label}
        {unit ? ` (${unit})` : ""}
      </legend>
      <input className="input" type="number" inputMode="decimal" placeholder="de la" value={min} onChange={(e) => onMin(e.target.value)} aria-label={`${label}, minim`} />
      <span aria-hidden="true">–</span>
      <input className="input" type="number" inputMode="decimal" placeholder="până la" value={max} onChange={(e) => onMax(e.target.value)} aria-label={`${label}, maxim`} />
    </fieldset>
  );
}

const STATE_OPTS = (all: Agg | null): Opt[] => [
  { value: "alert", label: FLAG_LABELS.alert, count: all?.flags.alert },
  { value: "act", label: FLAG_LABELS.act, count: all?.flags.act },
  { value: "warn", label: FLAG_LABELS.warn, count: all?.flags.warn },
  { value: "crit", label: FLAG_LABELS.crit, count: all?.flags.crit },
  { value: "noact", label: FLAG_LABELS.noact, count: all?.flags.noact },
  { value: "offline", label: FLAG_LABELS.offline, count: all?.flags.offline },
  { value: "batt", label: FLAG_LABELS.batt, count: all?.flags.batt },
  { value: "inactive", label: FLAG_LABELS.inactive, count: all?.flags.inactive },
  { value: "dup", label: FLAG_LABELS.dup, count: all?.flags.dup },
  { value: "ok", label: FLAG_LABELS.ok, count: all?.flags.statusOk },
  { value: "nostatus", label: FLAG_LABELS.nostatus, count: all?.flags.noStatus },
  { value: "button", label: FLAG_LABELS.button, count: all?.flags.button },
  { value: "magnet", label: FLAG_LABELS.magnet, count: all?.flags.magnet },
];

type PanelProps = { store: MeterStore | null; all: Agg | null; filters: Filters; patch: (p: Partial<Filters>) => void };

/** Numele din dicționar, cele mai numeroase primele, cu numărătoarea din TOATE rândurile (nu se schimbă cât filtrezi). */
const named = (names: string[], counts: ArrayLike<number> | undefined, sort: "count" | "name" = "count"): Opt[] => {
  const o = names.map((n, i) => ({ value: n, count: counts?.[i] })).filter((x) => x.value);
  return o.sort((a, b) => (sort === "name" ? a.value.localeCompare(b.value, "ro", { numeric: true }) : (b.count ?? 0) - (a.count ?? 0) || a.value.localeCompare(b.value)));
};

/** Cele patru liste din rândul principal: filială, oraș, profil, stare. */
export function MainSelects({ store, all, filters, patch }: PanelProps) {
  const d = store?.dict;
  return (
    <>
      <MultiSelect label="Filială" options={named(d?.br ?? [], all?.brs, "name")} selected={toList(filters.branch)} onChange={(v) => patch({ branch: fromList(v) })} />
      <MultiSelect label="Oraș / localitate" options={named(d?.ct ?? [], all?.cts)} selected={toList(filters.city)} onChange={(v) => patch({ city: fromList(v) })} />
      <MultiSelect label="Profil contor" options={named(d?.pf ?? [], all?.pfs)} selected={toList(filters.profile)} onChange={(v) => patch({ profile: fromList(v) })} />
      <MultiSelect label="Stare" options={STATE_OPTS(all)} selected={toList(filters.flag)} onChange={(v) => patch({ flag: fromList(v) })} />
    </>
  );
}

/** Filtrele suplimentare: radio (aplicație, concentrator, tip mesaj, frecvență, fPort), contor (model, an, facturare) și intervale numerice. */
export function AdvancedFilters({ store, all, filters, patch }: PanelProps) {
  const d = store?.dict;
  const frOpts: Opt[] = all ? Array.from(all.freq).map((c, k) => ({ value: String(k * 100), label: k === 0 ? "necunoscută" : `${(k / 10).toFixed(1)} MHz`, count: c })).filter((o) => (o.count ?? 0) > 0) : [];
  const portOpts: Opt[] = all ? Array.from(all.ports).map((c, k) => ({ value: String(k - 1), label: `port ${k - 1}`, count: c })).filter((o, i) => i > 0 && (o.count ?? 0) > 0) : [];
  const modelOpts: Opt[] = (store?.models ?? []).map((m, i) => ({ value: m, count: all?.models[i] }));
  const yearOpts: Opt[] = (store?.years ?? []).map((y, i) => ({ value: y, count: all?.years[i] })).sort((a, b) => a.value.localeCompare(b.value));
  return (
    <div className="adv" role="group" aria-label="Filtre suplimentare">
      <MultiSelect label="Aplicație" options={named(d?.ap ?? [], all?.apps)} selected={toList(filters.app)} onChange={(v) => patch({ app: fromList(v) })} />
      <MultiSelect label="Concentrator (gateway)" options={named(d?.gw ?? [], all?.gws)} selected={toList(filters.gw)} onChange={(v) => patch({ gw: fromList(v) })} />
      <MultiSelect label="Tip mesaj" options={named(d?.ty ?? [], all?.types)} selected={toList(filters.type)} onChange={(v) => patch({ type: fromList(v) })} />
      <MultiSelect label="Frecvență" options={frOpts} selected={toList(filters.fr)} onChange={(v) => patch({ fr: fromList(v) })} />
      <MultiSelect label="fPort" options={portOpts} selected={toList(filters.port)} onChange={(v) => patch({ port: fromList(v) })} />
      <MultiSelect label="Model contor" options={modelOpts} selected={toList(filters.model)} onChange={(v) => patch({ model: fromList(v) })} />
      <MultiSelect label="An / cod lot" options={yearOpts} selected={toList(filters.year)} onChange={(v) => patch({ year: fromList(v) })} />
      <label className="field">
        <span>Facturare</span>
        <select className="select" value={filters.billed} onChange={(e) => patch({ billed: e.target.value })}>
          <option value="">Oricare</option>
          <option value="1">Cu rând în facturare</option>
          <option value="0">Fără facturare</option>
        </select>
      </label>
      <label className="field">
        <span>Coordonate GPS</span>
        <select className="select" value={filters.geo} onChange={(e) => patch({ geo: e.target.value })}>
          <option value="">Oricare</option>
          <option value="1">Cu coordonate</option>
          <option value="0">Fără coordonate</option>
        </select>
      </label>
      <label className="field">
        <span>Grup „Defectate” în SCADA</span>
        <select className="select" value={filters.defect} onChange={(e) => patch({ defect: e.target.value })}>
          <option value="">Toate</option>
          <option value="1">Doar cele din grupul Defectate</option>
          <option value="0">Fără grupul Defectate</option>
        </select>
      </label>
      <Range label="Volume" unit="m³" min={filters.valMin} max={filters.valMax} onMin={(v) => patch({ valMin: v })} onMax={(v) => patch({ valMax: v })} />
      <Range label="Consum zilnic" unit="L" min={filters.dcMin} max={filters.dcMax} onMin={(v) => patch({ dcMin: v })} onMax={(v) => patch({ dcMax: v })} />
      <Range label="Baterie" unit="%" min={filters.batMin} max={filters.batMax} onMin={(v) => patch({ batMin: v })} onMax={(v) => patch({ batMax: v })} />
      <Range label="RSSI" unit="dBm" min={filters.rssiMin} max={filters.rssiMax} onMin={(v) => patch({ rssiMin: v })} onMax={(v) => patch({ rssiMax: v })} />
      <Range label="SNR" unit="dB" min={filters.snrMin} max={filters.snrMax} onMin={(v) => patch({ snrMin: v })} onMax={(v) => patch({ snrMax: v })} />
      <Range label="fCnt" min={filters.fcMin} max={filters.fcMax} onMin={(v) => patch({ fcMin: v })} onMax={(v) => patch({ fcMax: v })} />
    </div>
  );
}

/** Filtrele active, ca etichete cu ✕ (vezi dintr-o privire ce restrânge lista). */
export function ActiveChips({ filters, patch, reset, nameOf }: { filters: Filters; patch: (p: Partial<Filters>) => void; reset: () => void; nameOf?: (id: string) => string }) {
  const chips = describeFilters(filters, nameOf);
  if (chips.length === 0) return null;
  return (
    <div className="chips" role="group" aria-label="Filtre active">
      {chips.map((c) => (
        <span key={c.id} className="chip-x">
          {c.label}
          <button type="button" onClick={() => patch(c.clear)} aria-label={`Elimină filtrul: ${c.label}`}>
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
  );
}
