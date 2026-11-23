"use client";

import { useEffect, useId, useRef, useState } from "react";
import { EMPTY_LABEL, EMPTY_TOKEN, type ColDef } from "@/lib/source-shared";
import { setRange, setSel, setTxt, type SFilters } from "@/lib/source-filter";
import type { SourceStore } from "@/lib/source-store";
import { MultiSelect, type Opt } from "./FilterPanel";

/** Filtrele paginilor pe sursă, generate din definițiile coloanelor: listă cu bife (dict), „conține” (text), interval (număr / dată). */

/** Valorile la care ordinea alfabetică (numerică) e mai utilă decât cea după număr de rânduri. */
const BY_NAME = new Set(["year", "model", "branch", "OTDELEN", "FIL", "REPEAT", "NUM_CAR", "KOD_AB", "dup", "std", "radioDup"]);
export type OptionsMap = Record<string, Opt[]>;
export type SetF = (fn: (f: SFilters) => SFilters) => void;

/** Opțiunile fiecărei liste: numele din dicționar cu numărătoarea din TOATE rândurile (nu se schimbă cât filtrezi) + „fără valoare”. */
export function buildOptions(store: SourceStore | null, counts: Record<string, Int32Array> | null): OptionsMap {
  const out: OptionsMap = {};
  if (!store) return out;
  for (const c of store.cols) {
    if (c.kind !== "dict") continue;
    const names = store.dict[c.key] ?? [];
    const cnt = counts?.[c.key];
    const o: Opt[] = names.map((v, i) => ({ value: v, label: store.label(c, v), count: cnt?.[i] }));
    o.sort((a, b) => (BY_NAME.has(c.key) ? a.value.localeCompare(b.value, "ro", { numeric: true }) : (b.count ?? 0) - (a.count ?? 0) || a.value.localeCompare(b.value, "ro", { numeric: true })));
    if (cnt && cnt[names.length] > 0) o.push({ value: EMPTY_TOKEN, label: EMPTY_LABEL, count: cnt[names.length] });
    out[c.key] = o;
  }
  return out;
}

const ro = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : s);

/** Interval de zile: buton + fereastră cu două câmpuri de dată (în antet nu încap două câmpuri de dată una lângă alta). */
export function DateRange({ label, min, max, onChange, compact, align }: { label: string; min: string; max: string; onChange: (min: string, max: string) => void; compact?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
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
  const summary = min && max ? `${ro(min)} – ${ro(max)}` : min ? `de la ${ro(min)}` : max ? `până la ${ro(max)}` : "Oricând";
  return (
    <div className={`field ms ${compact ? "ms-compact" : ""} ${align === "right" ? "ms-right" : ""}`} ref={ref}>
      <span id={id} className={compact ? "sr-only" : undefined}>{label}</span>
      <button type="button" className={`select ms-btn ${min || max ? "on" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-labelledby={id} onClick={() => setOpen((v) => !v)}>
        <span className="ms-sum">{summary}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="ms-pop" role="dialog" aria-label={label} style={{ minWidth: 230 }}>
          <label className="field" style={{ marginBottom: 8 }}>
            <span>De la</span>
            <input className="input" type="date" value={min} max={max || undefined} onChange={(e) => onChange(e.target.value, max)} />
          </label>
          <label className="field">
            <span>Până la</span>
            <input className="input" type="date" value={max} min={min || undefined} onChange={(e) => onChange(min, e.target.value)} />
          </label>
          <div className="ms-foot">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange("", "")} disabled={!min && !max}>
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

function NumRange({ label, min, max, onChange, compact }: { label: string; min: string; max: string; onChange: (min: string, max: string) => void; compact?: boolean }) {
  const cls = compact ? "input cf-in" : "input";
  return (
    <div className={compact ? "cf-range" : undefined} role="group" aria-label={label} style={compact ? undefined : { display: "contents" }}>
      <input className={cls} type="number" inputMode="decimal" placeholder="de la" value={min} onChange={(e) => onChange(e.target.value, max)} aria-label={`${label}, minim`} />
      {!compact && <span aria-hidden="true">–</span>}
      <input className={cls} type="number" inputMode="decimal" placeholder="până la" value={max} onChange={(e) => onChange(min, e.target.value)} aria-label={`${label}, maxim`} />
    </div>
  );
}

/** Filtrul unei coloane, în antetul tabelului (compact) sau în „Mai multe filtre” (cu etichetă). */
export function ColFilter({ c, options, f, setF, compact, align }: { c: ColDef; options: OptionsMap; f: SFilters; setF: SetF; compact?: boolean; align?: "left" | "right" }) {
  switch (c.kind) {
    case "dict":
      return <MultiSelect compact={compact} align={align} label={c.label} options={options[c.key] ?? []} selected={f.sel[c.key] ?? []} onChange={(v) => setF((x) => setSel(x, c.key, v))} />;
    case "text":
      return compact ? (
        <input className="input cf-in" type="search" placeholder="conține…" aria-label={`${c.label} conține`} value={f.txt[c.key] ?? ""} onChange={(e) => setF((x) => setTxt(x, c.key, e.target.value))} autoComplete="off" spellCheck={false} />
      ) : (
        <label className="field">
          <span>{c.label}</span>
          <input className="input" type="search" placeholder="conține…" value={f.txt[c.key] ?? ""} onChange={(e) => setF((x) => setTxt(x, c.key, e.target.value))} autoComplete="off" spellCheck={false} />
        </label>
      );
    case "date":
      return <DateRange compact={compact} align={align} label={c.label} min={f.min[c.key] ?? ""} max={f.max[c.key] ?? ""} onChange={(a, b) => setF((x) => setRange(x, c.key, a, b))} />;
    case "num":
      return compact ? (
        <NumRange compact label={c.label} min={f.min[c.key] ?? ""} max={f.max[c.key] ?? ""} onChange={(a, b) => setF((x) => setRange(x, c.key, a, b))} />
      ) : (
        <fieldset className="range">
          <legend>{c.label}</legend>
          <NumRange label={c.label} min={f.min[c.key] ?? ""} max={f.max[c.key] ?? ""} onChange={(a, b) => setF((x) => setRange(x, c.key, a, b))} />
        </fieldset>
      );
  }
}

/** „Mai multe filtre”: toate coloanele care nu au loc în antetul tabelului. */
export function AdvancedPanel({ store, options, f, setF }: { store: SourceStore | null; options: OptionsMap; f: SFilters; setF: SetF }) {
  const hidden = (store?.cols ?? []).filter((c) => !c.show);
  return (
    <div className="adv" role="group" aria-label="Filtre suplimentare">
      {hidden.map((c) => (
        <ColFilter key={c.key} c={c} options={options} f={f} setF={setF} />
      ))}
      {hidden.length === 0 && <p className="cell-sub" style={{ margin: 0 }}>Toate coloanele au filtru în antetul tabelului.</p>}
    </div>
  );
}

/** Dacă vreun filtru e pe o coloană fără loc în antet, panoul „Mai multe filtre” se deschide singur. */
export function hasAdvanced(f: SFilters, cols: ColDef[] | undefined): boolean {
  if (!cols) return false;
  const hidden = new Set(cols.filter((c) => !c.show).map((c) => c.key));
  return [...Object.keys(f.sel), ...Object.keys(f.txt), ...Object.keys(f.min), ...Object.keys(f.max)].some((k) => hidden.has(k));
}
