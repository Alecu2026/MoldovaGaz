"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ALL_COLUMNS, DEFAULT_COLS, GROUP_LABELS, type ColDef, type ColKey } from "./meter-columns";

/** Butonul „Coloane”: bifezi ce coloane vrei în tabel (ca în SCADA). Contorul rămâne mereu. Alegerea o reține părintele (în browser). */
export default function ColumnPicker({ value, onChange }: { value: ColKey[]; onChange: (v: ColKey[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const on = new Set(value);
  const toggle = (c: ColKey) => {
    if (c === "dev") return;
    const next = new Set(on);
    if (next.has(c)) next.delete(c); else next.add(c);
    onChange(ALL_COLUMNS.filter((d) => next.has(d.col)).map((d) => d.col));
  };
  const groups = (Object.keys(GROUP_LABELS) as ColDef["group"][]).map((g) => ({ g, cols: ALL_COLUMNS.filter((c) => c.group === g) }));
  const extra = value.length - DEFAULT_COLS.length;

  return (
    <div ref={box} className="colpick">
      <button type="button" className="btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        Coloane ({value.length}) {open ? "▴" : "▾"}
      </button>
      {open && (
        <div id={id} className="colpick-panel" role="dialog" aria-label="Alege coloanele">
          <div className="colpick-top">
            <button type="button" className="btn btn-sm" onClick={() => onChange(DEFAULT_COLS)}>Implicit</button>
            <button type="button" className="btn btn-sm" onClick={() => onChange(ALL_COLUMNS.map((c) => c.col))}>Toate</button>
            <span className="cell-sub">{extra === 0 ? "coloanele implicite" : "alegere proprie, reținută în browser"}</span>
          </div>
          {groups.map(({ g, cols }) => (
            <fieldset key={g}>
              <legend>{GROUP_LABELS[g]}</legend>
              {cols.map((c) => (
                <label key={c.col} className="chk">
                  <input type="checkbox" checked={on.has(c.col)} disabled={c.col === "dev"} onChange={() => toggle(c.col)} /> {c.label}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </div>
  );
}
