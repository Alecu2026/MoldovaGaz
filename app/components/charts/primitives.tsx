"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Grafice fără bibliotecă (câteva sute de linii): bare verticale (histograme / timp), listă de bare orizontale și hartă de densitate.
 * Reguli (ghidul de vizualizare): o singură culoare pentru categorii nominale (nu rampă pe valoare), contextul „toate” în gri în spatele
 * valorii filtrate (emfază), bare ≤ 24 px cu capăt rotunjit de 4 px și gol de 2 px între ele, grilă hairline solidă, text în culorile de text
 * (nu în culoarea seriei), tooltip și la hover și la focus, tabel-geamăn pentru fiecare grafic, rampă secvențială dintr-o singură nuanță pentru densitate.
 */

export const nf = new Intl.NumberFormat("ro-RO");
export const nf1 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 1 });
export function fmtAxis(n: number): string {
  if (n >= 1_000_000) return `${nf1.format(n / 1_000_000)} M`;
  if (n >= 10_000) return `${nf1.format(n / 1000)} K`;
  return nf.format(n);
}
export function niceMax(v: number): number {
  if (v <= 1) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Lățimea în pixeli a unui element (ResizeObserver): graficele se desenează la mărimea reală, nu scalate. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.floor(el.clientWidth));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const darkQuery = "(prefers-color-scheme: dark)";
const subscribeDark = (cb: () => void) => {
  const m = window.matchMedia(darkQuery);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
export const useDark = () => useSyncExternalStore(subscribeDark, () => window.matchMedia(darkQuery).matches, () => false);

/* ───────── tooltip (un singur element; conținutul vine ca text, nu ca HTML) ───────── */
export type Tip = { x: number; y: number; title: string; value: string; sub?: string };
function TipBox({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.max(4, Math.min(width - 4, tip.x));
  return (
    <div className="tip" role="tooltip" style={{ left, top: tip.y, transform: `translate(${left > width - 150 ? "-100%" : left < 150 ? "0" : "-50%"}, -100%)` }}>
      <div className="tip-v">{tip.value}</div>
      <div className="tip-t">{tip.title}</div>
      {tip.sub && <div className="tip-s">{tip.sub}</div>}
    </div>
  );
}

/* ───────── card cu tabel-geamăn ───────── */
export type TableTwin = { head: string[]; rows: (string | number)[][] };
export function ChartCard({ title, hint, span, table, children }: { title: string; hint?: string; span?: 2 | 3; table?: TableTwin; children: React.ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`card ${span === 2 ? "span2" : span === 3 ? "span3" : ""}`} aria-label={title}>
      <header className="card-h">
        <div style={{ minWidth: 0 }}>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
        {table && (
          <button type="button" className="btn btn-sm btn-ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)} title="Vezi datele ca tabel">
            Tabel
          </button>
        )}
      </header>
      {asTable && table ? (
        <div className="card-table">
          <table className="mini">
            <thead>
              <tr>
                {table.head.map((h, i) => (
                  <th key={h} className={i > 0 ? "num" : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className={j > 0 ? "num mono" : undefined}>
                      {typeof c === "number" ? nf.format(c) : c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/* ───────── bare verticale: timp, histograme, DR ───────── */
export type Bar = { label: string; /** text scurt pe axă (implicit label) */ axis?: string; value: number; ghost: number; sub?: string };

function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.max(0, Math.min(4, h, w / 2));
  return `M${x},${y + h}L${x},${y + r}Q${x},${y} ${x + r},${y}L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h}Z`;
}

export function ColumnChart({
  bars,
  ariaLabel,
  height = 190,
  selected,
  onBar,
  onBrush,
  labelEvery,
  labelWidth = 64,
  unit,
}: {
  bars: Bar[];
  ariaLabel: string;
  height?: number;
  /** care bare sunt „active” (filtrate prin acest grafic); restul se estompează */
  selected?: (i: number) => boolean;
  onBar?: (i: number) => void;
  /** glisare peste un interval de bare */
  onBrush?: (from: number, to: number) => void;
  labelEvery?: number;
  /** lățimea rezervată unei etichete pe axă (px) */
  labelWidth?: number;
  /** unitatea valorii din hover (ex. „m³”, „contoare”) */
  unit?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const n = bars.length;
  const ML = 44, MR = 8, MT = 10, MB = 26;
  const pw = Math.max(20, w - ML - MR);
  const ph = height - MT - MB;
  const max = niceMax(Math.max(1, ...bars.map((b) => Math.max(b.value, b.ghost))));
  const band = pw / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => MT + ph - (v / max) * ph;
  const anySel = !!selected && bars.some((_, i) => selected(i));
  const every = labelEvery ?? Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / labelWidth))));
  const interactive = !!(onBar || onBrush);

  const indexAt = useCallback((e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
  }, [n]);

  const tip: Tip | null =
    hover != null && bars[hover]
      ? { x: ML + (hover + 0.5) * band, y: Math.max(14, y(Math.max(bars[hover].value, 0)) - 6), title: bars[hover].label, value: `${nf.format(bars[hover].value)}${unit ? ` ${unit}` : ""}`, sub: bars[hover].ghost > bars[hover].value ? `din ${nf.format(bars[hover].ghost)} ${unit ?? ""} în total`.replace(/ +/g, " ") : bars[hover].sub }
      : null;

  return (
    <div className="chart-wrap" ref={ref}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} style={{ display: "block", touchAction: "pan-y" }}>
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={ML} x2={ML + pw} y1={y(max * t)} y2={y(max * t)} stroke="var(--viz-grid)" strokeWidth={1} />
              <text x={ML - 6} y={y(max * t) + 4} textAnchor="end" className="ax">
                {fmtAxis(Math.round(max * t))}
              </text>
            </g>
          ))}
          {bars.map((b, i) => {
            const cx = ML + (i + 0.5) * band;
            const dim = anySel && !selected!(i);
            const showLabel = i % every === 0;
            return (
              <g key={i} opacity={dim ? 0.35 : 1}>
                {hover === i && <rect x={ML + i * band} y={MT} width={band} height={ph} fill="var(--viz-hover)" />}
                {b.ghost > b.value && b.ghost > 0 && <path d={topRounded(cx - bw / 2, y(b.ghost), bw, y(0) - y(b.ghost))} fill="var(--viz-ghost)" />}
                {b.value > 0 && <path d={topRounded(cx - bw / 2, y(b.value), bw, y(0) - y(b.value))} fill="var(--series-1)" />}
                {showLabel && (
                  <text x={cx} y={height - 8} textAnchor="middle" className="ax">
                    {b.axis ?? b.label}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={ML} x2={ML + pw} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" strokeWidth={1} />
          {drag && <rect x={ML + Math.min(drag.a, drag.b) * band} y={MT} width={(Math.abs(drag.b - drag.a) + 1) * band} height={ph} fill="var(--series-1)" opacity={0.14} stroke="var(--series-1)" strokeWidth={1} />}
          <rect
            x={ML}
            y={MT}
            width={pw}
            height={ph + 4}
            fill="transparent"
            style={{ cursor: interactive ? (onBrush ? "crosshair" : "pointer") : "default" }}
            onPointerDown={(e) => {
              if (!interactive) return;
              (e.currentTarget as SVGRectElement).setPointerCapture(e.pointerId);
              const i = indexAt(e);
              setDrag({ a: i, b: i });
            }}
            onPointerMove={(e) => {
              const i = indexAt(e);
              setHover(i);
              setDrag((d) => (d ? { a: d.a, b: i } : d));
            }}
            onPointerUp={(e) => {
              if (!drag) return;
              const i = indexAt(e);
              const a = Math.min(drag.a, i), b = Math.max(drag.a, i);
              setDrag(null);
              if (a === b) onBar?.(a);
              else if (onBrush) onBrush(a, b);
              else onBar?.(a);
            }}
            onPointerLeave={() => setHover(null)}
            onPointerCancel={() => setDrag(null)}
          />
        </svg>
      )}
      <TipBox tip={tip} width={w} />
    </div>
  );
}

/* ───────── listă de bare orizontale (categorii nominale: o singură culoare) ───────── */
export type BarItem = { key: string; label: string; value: number; ghost: number; sub?: string; /** text afișat în loc de valoare (când lungimea barei e o transformare a valorii reale, ex. RSSI) */ show?: string; tone?: "critical" | "serious" | "warning" | "good" | "neutral"; glyph?: string };

export function BarList({ items, selected = [], onToggle, top = 10, ariaLabel, unit }: { items: BarItem[]; selected?: string[]; onToggle?: (key: string) => void; top?: number; ariaLabel: string; /** unitatea valorii din hover */ unit?: string }) {
  const [all, setAll] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [ref, w] = useWidth<HTMLDivElement>();
  const shown = all ? items : items.slice(0, top);
  const max = Math.max(1, ...items.map((i) => Math.max(i.value, i.ghost)));
  const anySel = selected.length > 0;
  const showTip = (it: BarItem, el: HTMLElement, clientX?: number) => {
    const wrap = ref.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!wrap) return;
    setTip({ x: (clientX ?? r.left + r.width / 2) - wrap.left, y: r.top - wrap.top - 2, title: it.label, value: it.show ?? `${nf.format(it.value)}${unit ? ` ${unit}` : ""}`, sub: it.ghost > it.value ? `din ${nf.format(it.ghost)}${unit ? ` ${unit}` : ""} în total` : it.sub });
  };
  return (
    <div className="chart-wrap" ref={ref} role="list" aria-label={ariaLabel}>
      {shown.map((it) => {
        const on = selected.includes(it.key);
        const Tag = onToggle ? "button" : "div";
        return (
          <Tag
            key={it.key}
            role="listitem"
            className={`bl-row ${on ? "on" : ""} ${anySel && !on ? "dim" : ""}`}
            {...(onToggle ? { type: "button" as const, onClick: () => onToggle(it.key), "aria-pressed": on } : {})}
            onPointerMove={(e: React.PointerEvent<HTMLElement>) => showTip(it, e.currentTarget, e.clientX)}
            onPointerLeave={() => setTip(null)}
            onFocus={(e: React.FocusEvent<HTMLElement>) => showTip(it, e.currentTarget)}
            onBlur={() => setTip(null)}
          >
            <span className="bl-label">
              {it.glyph && <span aria-hidden="true" className={`bl-glyph ${it.tone ?? ""}`}>{it.glyph}</span>}
              <span className="bl-text">{it.label}</span>
            </span>
            <span className="bl-track" aria-hidden="true">
              {it.ghost > it.value && <span className="bl-bar ghost" style={{ width: `${(it.ghost / max) * 100}%` }} />}
              <span className={`bl-bar ${it.tone ?? ""}`} style={{ width: `${(it.value / max) * 100}%` }} />
            </span>
            <span className="bl-val mono">{it.show ?? nf.format(it.value)}</span>
          </Tag>
        );
      })}
      {items.length > top && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll((v) => !v)} style={{ marginTop: 4 }}>
          {all ? "Arată mai puține" : `Arată toate (${items.length})`}
        </button>
      )}
      {items.length === 0 && <p className="cell-sub" style={{ margin: 0 }}>Nicio dată.</p>}
      <TipBox tip={tip} width={w} />
    </div>
  );
}

/* ───────── hartă de densitate (RSSI × SNR): rampă dintr-o singură nuanță ───────── */
const RAMP_LIGHT = ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];
const RAMP_DARK = ["#1d2b3d", "#184f95", "#2a78d6", "#6da7ec", "#cde2fb"];
function ramp(t: number, stops: string[]): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const p = (h: string, k: number) => parseInt(h.slice(1 + 2 * k, 3 + 2 * k), 16);
  const c = (k: number) => Math.round(p(stops[i], k) * (1 - f) + p(stops[i + 1], k) * f);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

export function Heat({
  counts, nx, ny, x0, xStep, y0, yStep, xLabel, yLabel, onBrush, ariaLabel, height = 260,
}: {
  counts: Int32Array; nx: number; ny: number; x0: number; xStep: number; y0: number; yStep: number; xLabel: string; yLabel: string;
  onBrush?: (xMin: number, xMax: number, yMin: number, yMax: number) => void; ariaLabel: string; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const dark = useDark();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ ax: number; ay: number; bx: number; by: number } | null>(null);
  const ML = 40, MR = 8, MT = 22, MB = 36;
  const pw = Math.max(40, w - ML - MR), ph = height - MT - MB;
  const cw = pw / nx, ch = ph / ny;
  let max = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] > max) max = counts[i];

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(pw * dpr);
    cv.height = Math.round(ph * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, pw, ph);
    const stops = dark ? RAMP_DARK : RAMP_LIGHT;
    const sm = Math.sqrt(max || 1);
    for (let yy = 0; yy < ny; yy++) {
      for (let xx = 0; xx < nx; xx++) {
        const c = counts[yy * nx + xx];
        if (!c) continue;
        g.fillStyle = ramp(Math.sqrt(c) / sm, stops);
        g.fillRect(xx * cw + 0.5, (ny - 1 - yy) * ch + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
      }
    }
  }, [counts, nx, ny, w, pw, ph, cw, ch, max, dark]);

  const cellAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(nx - 1, Math.floor(((e.clientX - r.left) / r.width) * nx)));
    const y = Math.max(0, Math.min(ny - 1, ny - 1 - Math.floor(((e.clientY - r.top) / r.height) * ny)));
    return { x, y };
  };
  const hv = hover ? counts[hover.y * nx + hover.x] : 0;
  const tip: Tip | null = hover
    ? {
        x: ML + (hover.x + 0.5) * cw,
        y: MT + (ny - 1 - hover.y) * ch - 4,
        value: nf.format(hv),
        title: `${yLabel} ${y0 + hover.y * yStep} … ${y0 + (hover.y + 1) * yStep} · ${xLabel} ${x0 + hover.x * xStep} … ${x0 + (hover.x + 1) * xStep}`,
      }
    : null;

  return (
    <div className="chart-wrap" ref={ref}>
      {w > 0 && (
        <div style={{ position: "relative", height }} role="img" aria-label={ariaLabel}>
          <canvas ref={canvas} style={{ position: "absolute", left: ML, top: MT, width: pw, height: ph }} />
          <svg width={w} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <rect x={ML} y={MT} width={pw} height={ph} fill="none" stroke="var(--viz-axis)" strokeWidth={1} />
            {Array.from({ length: Math.floor(nx / 4) + 1 }, (_, k) => k * 4).map((k) => (
              <text key={`x${k}`} x={ML + k * cw} y={MT + ph + 18} textAnchor="middle" className="ax">
                {x0 + k * xStep}
              </text>
            ))}
            {Array.from({ length: Math.floor(ny / 8) + 1 }, (_, k) => k * 8).map((k) => (
              <text key={`y${k}`} x={ML - 6} y={MT + ph - k * ch + 4} textAnchor="end" className="ax">
                {y0 + k * yStep}
              </text>
            ))}
            <text x={ML + pw / 2} y={height - 3} textAnchor="middle" className="ax">{xLabel}</text>
            <text x={ML} y={12} className="ax">{yLabel}</text>
            {drag && (
              <rect
                x={ML + Math.min(drag.ax, drag.bx) * cw} y={MT + (ny - 1 - Math.max(drag.ay, drag.by)) * ch}
                width={(Math.abs(drag.bx - drag.ax) + 1) * cw} height={(Math.abs(drag.by - drag.ay) + 1) * ch}
                fill="var(--series-1)" opacity={0.18} stroke="var(--series-1)"
              />
            )}
          </svg>
          <div
            style={{ position: "absolute", left: ML, top: MT, width: pw, height: ph, cursor: onBrush ? "crosshair" : "default", touchAction: "pan-y" }}
            onPointerDown={(e) => {
              if (!onBrush) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const c = cellAt(e);
              setDrag({ ax: c.x, ay: c.y, bx: c.x, by: c.y });
            }}
            onPointerMove={(e) => {
              const c = cellAt(e);
              setHover(c);
              setDrag((d) => (d ? { ...d, bx: c.x, by: c.y } : d));
            }}
            onPointerUp={(e) => {
              if (!drag) return;
              const c = cellAt(e);
              const xa = Math.min(drag.ax, c.x), xb = Math.max(drag.ax, c.x), ya = Math.min(drag.ay, c.y), yb = Math.max(drag.ay, c.y);
              setDrag(null);
              onBrush?.(x0 + xa * xStep, x0 + (xb + 1) * xStep, y0 + ya * yStep, y0 + (yb + 1) * yStep);
            }}
            onPointerLeave={() => setHover(null)}
            onPointerCancel={() => setDrag(null)}
          />
        </div>
      )}
      <TipBox tip={tip} width={w} />
    </div>
  );
}
