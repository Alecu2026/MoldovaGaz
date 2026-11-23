"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { SOURCES } from "@/lib/source-shared";
import type { SourceStore } from "@/lib/source-store";

const p2 = (n: number) => String(n).padStart(2, "0");
const dt = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

/** Coloana care identifică „aceeași serie” în fiecare sursă (butonul „Arată rândurile cu aceeași serie”). */
export const SERIES_KEY = { lorawan: "serial", billing: "NUM_RADIO" } as const;

type Props = { store: SourceStore; i: number; onClose: () => void; onSeries: (key: string, value: string) => void };

/** Panou lateral cu toate câmpurile unui rând din sursă, așa cum le dă sursa (plus coloanele derivate din aceeași sursă). */
export default function SourceDetail({ store, i, onClose, onSeries }: Props) {
  const meta = SOURCES[store.source];
  const closeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // focus în panou, Esc închide, Tab rămâne în panou; la închidere focusul revine unde era
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !boxRef.current) return;
      const f = boxRef.current.querySelectorAll<HTMLElement>("button, a[href], summary, select, [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  const val = (key: string) => {
    const c = store.byKey.get(key);
    return c ? store.text(i, c) : "";
  };
  const title = store.source === "lorawan" ? val("name") : val("NUM_RADIO") || val("CONTOR_SN") || val("ACCT_ID") || "Rând de facturare";
  const sub = store.source === "lorawan" ? [val("type"), val("created") ? dt(Number(val("created"))) : ""].filter(Boolean).join(" · ") : [val("branch"), val("CITY")].filter(Boolean).join(" · ");
  const seriesKey = SERIES_KEY[store.source];
  const series = val(seriesKey);
  const repeated = store.source === "lorawan" ? val("dup") === "Da" : val("radioDup") === "Da";
  const combined = store.source === "lorawan" ? `/?name=${encodeURIComponent(val("name"))}` : series ? `/?q=${encodeURIComponent(series)}` : null;

  const fields = store.cols.map((c) => {
    const raw = store.text(i, c);
    let shown = raw;
    if (c.kind === "date" && raw) shown = dt(Number(raw));
    return { c, raw, shown };
  });

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="src-detail-title" ref={boxRef} style={{ width: "min(640px, 100%)" }}>
        <header>
          <div style={{ minWidth: 0 }}>
            <h2 id="src-detail-title">{title}</h2>
            <div className="cell-sub">{sub || " "}</div>
          </div>
          <button ref={closeRef} className="btn btn-sm" onClick={onClose} aria-label="Închide detaliile">
            Închide
          </button>
        </header>

        <section>
          <h3>Date din {meta.origin.split(" (")[0]}</h3>
          <dl className="kv">
            {fields.map(({ c, raw, shown }) => (
              <div key={c.key} style={{ display: "contents" }}>
                <dt title={c.hint}>{c.label}</dt>
                <dd className={c.mono ? "mono" : undefined}>{raw ? shown : <span className="cell-sub">—</span>}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h3>Mai departe</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {repeated && series && (
              <button type="button" className="btn" onClick={() => onSeries(seriesKey, series)}>
                Arată {meta.nounPlural} cu aceeași serie ({series})
              </button>
            )}
            {combined && (
              <Link className="btn" href={combined}>
                Deschide în pagina principală (date combinate)
              </Link>
            )}
          </div>
          <p className="cell-sub" style={{ marginBottom: 0 }}>
            Această pagină arată doar ce vine din {meta.origin.split(" (")[0]}. Valorile din ThingsBoard (volum, semnal, baterie, coordonate) și legătura dintre cele două surse sunt în pagina principală.
          </p>
        </section>
      </div>
    </div>
  );
}
