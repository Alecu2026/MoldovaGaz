"use client";

import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Pânză de widgeturi: fiecare widget se TRAGE (mânerul ⠿ din colț, sau cu săgeți) ca să-i schimbi locul, se ÎNCHIDE (×) și se redimensionează (vezi Widget).
 * Butonul „Widgeturi” arată toate widgeturile, cu bife pentru ce e vizibil, și „Aranjare implicită”. Ordinea și ce e ascuns se rețin în browser, pe pagină.
 * Tragerea folosește API-ul nativ de drag & drop (mouse); de la tastatură mânerul se mută cu săgețile.
 */
export type BoardItem = { id: string; title: string; node: React.ReactNode };
export type BoardApi = {
  dragId: string | null;
  overId: string | null;
  setDrag: (id: string | null) => void;
  setOver: (id: string | null) => void;
  dropOn: (targetId: string) => void;
  hide: (id: string) => void;
  moveBy: (id: string, delta: number) => void;
};
const Ctx = createContext<BoardApi | null>(null);
/** Contextul pânzei; null când widgetul nu e pe o pânză. */
export const useBoard = (): BoardApi | null => useContext(Ctx);

const key = (id: string) => `mg:board:${id}`;

export default function Board({ id, items }: { id: string; items: BoardItem[] }) {
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const [order, setOrder] = useState<string[]>(ids);
  const [hidden, setHidden] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const v = JSON.parse(localStorage.getItem(key(id)) ?? "null") as { order?: unknown; hidden?: unknown } | null;
        if (!v) return;
        const known = new Set(ids);
        const o = Array.isArray(v.order) ? (v.order as unknown[]).filter((x): x is string => typeof x === "string" && known.has(x)) : [];
        setOrder([...o, ...ids.filter((x) => !o.includes(x))]);
        if (Array.isArray(v.hidden)) setHidden((v.hidden as unknown[]).filter((x): x is string => typeof x === "string" && known.has(x)));
      } catch { /* fără aranjare reținută */ }
    }, 0);
    return () => clearTimeout(t);
  }, [id, ids]);

  const save = useCallback((o: string[], h: string[]) => { try { localStorage.setItem(key(id), JSON.stringify({ order: o, hidden: h })); } catch { /* aranjarea nu se reține */ } }, [id]);
  const known = order.filter((x) => ids.includes(x));
  const full = [...known, ...ids.filter((x) => !known.includes(x))];
  const visible = full.filter((x) => !hidden.includes(x));

  const place = (from: string, to: string) => {
    if (from === to) return;
    const a = full.indexOf(from), b = full.indexOf(to);
    if (a < 0 || b < 0) return;
    const next = full.filter((x) => x !== from);
    next.splice(next.indexOf(to) + (a < b ? 1 : 0), 0, from);
    setOrder(next);
    save(next, hidden);
  };
  const api: BoardApi = {
    dragId, overId,
    setDrag: setDragId,
    setOver: setOverId,
    dropOn: (target) => { if (dragId) place(dragId, target); setDragId(null); setOverId(null); },
    hide: (x) => { const h = [...hidden, x]; setHidden(h); save(full, h); },
    moveBy: (x, delta) => {
      const i = visible.indexOf(x), j = i + delta;
      if (i < 0 || j < 0 || j >= visible.length) return;
      place(x, visible[j]);
    },
  };
  const toggle = (x: string) => { const h = hidden.includes(x) ? hidden.filter((y) => y !== x) : [...hidden, x]; setHidden(h); save(full, h); };
  const reset = () => { setOrder(ids); setHidden([]); try { localStorage.removeItem(key(id)); } catch { /* nimic de șters */ } try { Object.keys(localStorage).filter((k) => k.startsWith("mg:widget:")).forEach((k) => localStorage.removeItem(k)); } catch { /* nimic de șters */ } window.location.reload(); };

  return (
    <Ctx.Provider value={api}>
      <div className="boardbar">
        <div className="colpick">
          <button type="button" className="btn" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            Widgeturi ({visible.length}/{ids.length}) {menu ? "▴" : "▾"}
          </button>
          {menu && (
            <div className="colpick-panel" role="dialog" aria-label="Alege widgeturile" style={{ width: "min(360px, 92vw)" }}>
              <div className="colpick-top">
                <button type="button" className="btn btn-sm" onClick={() => { setHidden([]); save(full, []); }}>Arată toate</button>
                <button type="button" className="btn btn-sm" onClick={reset}>Aranjare implicită</button>
              </div>
              <fieldset style={{ gridTemplateColumns: "1fr" }}>
                <legend>Vizibile</legend>
                {full.map((x) => (
                  <label key={x} className="chk">
                    <input type="checkbox" checked={!hidden.includes(x)} onChange={() => toggle(x)} /> {items.find((i) => i.id === x)?.title ?? x}
                  </label>
                ))}
              </fieldset>
              <p className="cell-sub" style={{ whiteSpace: "normal", margin: "8px 0 0" }}>Trage ⠿ din colțul unui widget ca să-l muți, × ca să-l închizi; trage marginea sau colțul ca să-l mărești / micșorezi.</p>
            </div>
          )}
        </div>
        {hidden.length > 0 && <span className="cell-sub">{hidden.length} ascunse</span>}
      </div>
      <div className="canvas">
        {visible.map((x) => <Fragment key={x}>{items.find((i) => i.id === x)?.node}</Fragment>)}
      </div>
    </Ctx.Provider>
  );
}
