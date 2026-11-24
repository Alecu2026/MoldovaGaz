"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Poza unui contor într-un popup cu zoom: rotița (spre cursor), butoanele +/−, dublu-click (×1 ↔ ×3), tragere cu mouse-ul / degetul pentru deplasare, ciupire pe ecran tactil,
 * tastele + − 0 și săgețile; Esc sau click pe fundal închide (doar popup-ul, nu și panoul contorului de sub el).
 */
type View = { s: number; x: number; y: number };
const MIN = 1, MAX = 12;
const FIT: View = { s: 1, x: 0, y: 0 };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export default function PhotoViewer({ id, title, onClose, base = "/api/meters" }: { id: string; title: string; onClose: () => void; /** adresa API-ului de poze (contoare sau antene) */ base?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const cur = useRef<View>(FIT);
  const [view, setView] = useState<View>(FIT);
  const [load, setLoad] = useState<"load" | "ok" | "err">("load");
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ d: number; mx: number; my: number; v: View } | null>(null);
  const moved = useRef(false);
  const downOnBg = useRef(false);
  const src = `${base}/${id}/photo`;

  const apply = (v: View) => {
    const st = stage.current, im = img.current;
    let { x, y } = v;
    if (st && im) {
      const bx = (im.offsetWidth * v.s) / 2 + st.clientWidth / 2 - 80, by = (im.offsetHeight * v.s) / 2 + st.clientHeight / 2 - 80;
      x = clamp(x, -bx, bx); y = clamp(y, -by, by);
    }
    const n = v.s <= MIN + 1e-6 ? FIT : { s: v.s, x, y };
    cur.current = n;
    setView(n);
  };
  /** zoom cu factorul `f`, ținând fix punctul (cx, cy) față de centrul ecranului */
  const zoomAt = (f: number, cx = 0, cy = 0) => {
    const v = cur.current, s = clamp(v.s * f, MIN, MAX);
    apply({ s, x: cx - ((cx - v.x) * s) / v.s, y: cy - ((cy - v.y) * s) / v.s });
  };
  const rel = (clientX: number, clientY: number) => {
    const r = stage.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 } : { x: 0, y: 0 };
  };

  // rotița: ascultător nativ (non-passive), ca să nu deruleze pagina din spate
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = rel(e.clientX, e.clientY);
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), p.x, p.y);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // tastatură: Esc închide DOAR popup-ul (faza de captură oprește și închiderea panoului de dedesubt); Tab rămâne în popup
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    stage.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); onClose(); return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomAt(1.4); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomAt(1 / 1.4); }
      else if (e.key === "0") { e.preventDefault(); apply(FIT); }
      else if (e.key.startsWith("Arrow") && cur.current.s > 1) {
        e.preventDefault();
        const v = cur.current, d = 60;
        apply({ ...v, x: v.x + (e.key === "ArrowLeft" ? d : e.key === "ArrowRight" ? -d : 0), y: v.y + (e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0) });
      } else if (e.key === "Tab" && stage.current) {
        const f = stage.current.querySelectorAll<HTMLElement>("button, a[href]");
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!stage.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".pv-bar")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    downOnBg.current = e.target === e.currentTarget;
    const pts = [...ptrs.current.values()];
    gesture.current = pts.length === 2 ? { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2, v: cur.current } : { d: 0, mx: e.clientX, my: e.clientY, v: cur.current };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId) || !gesture.current) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current, pts = [...ptrs.current.values()];
    if (pts.length >= 2 && g.d > 0) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      const s = clamp(g.v.s * (d / g.d), MIN, MAX), c = rel(g.mx, g.my);
      const x0 = c.x - ((c.x - g.v.x) * s) / g.v.s, y0 = c.y - ((c.y - g.v.y) * s) / g.v.s;
      apply({ s, x: x0 + (mx - g.mx), y: y0 + (my - g.my) });
      moved.current = true;
    } else if (pts.length === 1 && g.v.s > 1) {
      const dx = e.clientX - g.mx, dy = e.clientY - g.my;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true;
      apply({ s: g.v.s, x: g.v.x + dx, y: g.v.y + dy });
    } else if (Math.abs(e.clientX - g.mx) + Math.abs(e.clientY - g.my) > 3) moved.current = true;
  };
  const onUp = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    const pts = [...ptrs.current.values()];
    gesture.current = pts.length === 1 ? { d: 0, mx: pts[0].x, my: pts[0].y, v: cur.current } : null;
  };
  const onDouble = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pv-bar")) return;
    const p = rel(e.clientX, e.clientY);
    if (cur.current.s > 1.05) apply(FIT); else zoomAt(3, p.x, p.y);
  };
  // click pe fundal închide; nu și pe poză sau pe bară, nici după o tragere (cu pointerul „capturat”, ținta click-ului e mereu fundalul: de aceea ținem minte unde a început apăsarea)
  const onClick = () => { if (downOnBg.current && !moved.current) onClose(); };

  return createPortal(
    <div className="pv" ref={stage} role="dialog" aria-modal="true" aria-label={`Poza contorului ${title}`.trim()} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDouble} onClick={onClick}>
      <div className="pv-bar">
        <span className="pv-title">{title || "Poza contorului"}</span>
        <span className="pv-zoom" aria-live="polite">×{view.s.toFixed(view.s < 10 ? 1 : 0)}</span>
        <button type="button" className="btn btn-sm" onClick={() => zoomAt(1 / 1.5)} aria-label="Micșorează" title="Micșorează (−)">−</button>
        <button type="button" className="btn btn-sm" onClick={() => zoomAt(1.5)} aria-label="Mărește" title="Mărește (+)">+</button>
        <button type="button" className="btn btn-sm" onClick={() => apply(FIT)} title="Potrivește în fereastră (0)">Potrivește</button>
        <a className="btn btn-sm" href={src} target="_blank" rel="noopener noreferrer" title="Deschide poza într-o filă nouă">Filă nouă</a>
        <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Închide poza">Închide ×</button>
      </div>
      {load === "err" && <p className="pv-msg">Poza nu poate fi afișată.</p>}
      {load === "load" && <p className="pv-msg">se încarcă…</p>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={img} src={src} alt={`Poza contorului ${title}`.trim()} draggable={false} onLoad={() => setLoad("ok")} onError={() => setLoad("err")}
        className="pv-img" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, cursor: view.s > 1 ? "grab" : "zoom-in", visibility: load === "ok" ? "visible" : "hidden" }} />
    </div>,
    document.body,
  );
}
