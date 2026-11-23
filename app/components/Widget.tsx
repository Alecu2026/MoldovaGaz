"use client";

import { useEffect, useRef, useState } from "react";
import { useBoard } from "./Board";

/**
 * Widget redimensionabil, ca pe o pânză: un card pe care îl tragi de margina dreaptă (lățime), de cea de jos (înălțime) sau de colț (amândouă).
 * Lățimea nu depășește locul disponibil, deci un widget mai îngust lasă loc altuia alături (containerul `.canvas` împachetează widgeturile pe rânduri).
 * Mărimea se reține în browser, pe widget; dublu-click pe un mâner = mărimea inițială. Fără mouse: mânerele se focalizează și se mută cu săgețile.
 * În modul „mărit” (ExpandButton) cardul ocupă tot ecranul și mânerele dispar.
 */
type Size = { w: number | null; h: number };
const key = (id: string) => `mg:widget:${id}`;
const MIN_W = 320;
const MAX_H = 4000;

export default function Widget({ id, defaultH, minH = 240, expanded = false, ariaLabel, children }: { id: string; defaultH: number; minH?: number; expanded?: boolean; ariaLabel: string; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const board = useBoard();
  const [size, setSize] = useState<Size>({ w: null, h: defaultH });

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const v = JSON.parse(localStorage.getItem(key(id)) ?? "null") as { w?: unknown; h?: unknown } | null;
        if (v && typeof v.h === "number") setSize({ w: typeof v.w === "number" ? v.w : null, h: Math.max(minH, Math.min(MAX_H, v.h)) });
      } catch { /* fără mărime reținută */ }
    }, 0);
    return () => clearTimeout(t);
  }, [id, minH]);

  const save = (s: Size) => { try { localStorage.setItem(key(id), JSON.stringify(s)); } catch { /* mărimea nu se reține */ } };
  const reset = () => { setSize({ w: null, h: defaultH }); try { localStorage.removeItem(key(id)); } catch { /* nimic de șters */ } };
  const clampW = (w: number, max: number) => Math.round(Math.max(MIN_W, Math.min(max, w)));
  const clampH = (h: number) => Math.round(Math.max(minH, Math.min(MAX_H, h)));

  const drag = (mode: "r" | "b" | "rb") => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, w0 = el.offsetWidth, h0 = el.offsetHeight;
    const maxW = el.parentElement?.clientWidth ?? w0;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let last: Size = size;
    const move = (ev: PointerEvent) => {
      last = { w: mode.includes("r") ? clampW(w0 + ev.clientX - x0, maxW) : size.w, h: mode.includes("b") ? clampH(h0 + ev.clientY - y0) : size.h };
      setSize(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      save(last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const keys = (mode: "r" | "b" | "rb") => (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const d = e.shiftKey ? 120 : 40;
    const maxW = el.parentElement?.clientWidth ?? el.offsetWidth;
    let next: Size | null = null;
    if (mode.includes("r") && (e.key === "ArrowRight" || e.key === "ArrowLeft")) next = { w: clampW(el.offsetWidth + (e.key === "ArrowRight" ? d : -d), maxW), h: size.h };
    if (mode.includes("b") && (e.key === "ArrowDown" || e.key === "ArrowUp")) next = { w: size.w, h: clampH(el.offsetHeight + (e.key === "ArrowDown" ? d : -d)) };
    if (e.key === "Home") { reset(); e.preventDefault(); return; }
    if (next) { e.preventDefault(); setSize(next); save(next); }
  };

  const handle = (mode: "r" | "b" | "rb", cls: string, label: string) => (
    <div
      className={`rz ${cls}`}
      role="separator"
      aria-orientation={mode === "r" ? "vertical" : "horizontal"}
      aria-label={label}
      tabIndex={0}
      title="Trage ca să redimensionezi · dublu-click: mărimea inițială · de la tastatură: săgeți (Shift = mai mult)"
      onPointerDown={drag(mode)}
      onKeyDown={keys(mode)}
      onDoubleClick={reset}
    />
  );

  return (
    <section ref={ref} className={`card widget${expanded ? " expanded" : ""}`} aria-label={ariaLabel} style={expanded ? undefined : { width: size.w ?? "100%", height: size.h > 0 ? size.h : undefined }}
      data-over={board?.overId === id && board.dragId !== id ? "1" : undefined}
      onDragOver={(e) => { if (board?.dragId && board.dragId !== id) { e.preventDefault(); if (board.overId !== id) board.setOver(id); } }}
      onDragLeave={(e) => { if (board?.overId === id && !e.currentTarget.contains(e.relatedTarget as Node | null)) board.setOver(null); }}
      onDrop={(e) => { if (board?.dragId) { e.preventDefault(); board.dropOn(id); } }}
    >
      {board && !expanded && (
        <div className="wchrome">
          <span
            className="wdrag"
            role="button"
            tabIndex={0}
            draggable
            aria-label={`Mută widgetul: ${ariaLabel}`}
            title="Trage ca să muți widgetul (sau săgețile ← ↑ → ↓)"
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); board.setDrag(id); }}
            onDragEnd={() => { board.setDrag(null); board.setOver(null); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); board.moveBy(id, -1); }
              if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); board.moveBy(id, 1); }
            }}
          >
            ⠿
          </span>
          <button type="button" className="wclose" aria-label={`Închide widgetul: ${ariaLabel}`} title="Închide (îl readuci din „Widgeturi”)" onClick={() => board.hide(id)}>×</button>
        </div>
      )}
      <div className="wbody">{children}</div>
      {!expanded && (
        <>
          {handle("r", "rz-r", "Schimbă lățimea")}
          {handle("b", "rz-b", "Schimbă înălțimea")}
          {handle("rb", "rz-c", "Schimbă lățimea și înălțimea")}
        </>
      )}
    </section>
  );
}
