"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InstEdits, InstWire } from "@/lib/installer";

/**
 * Lista contoarelor din ecranul instalatorului, ținută în browser (ca în pagina Contoare): se descarcă o dată (ETag ⇒ 304 la redeschidere), apoi tabelul caută, sortează
 * și paginează LOCAL, instant, chiar și pentru zeci de mii de contoare. Se pune la zi singură cu rândurile schimbate (la 90 s și când revii în pagină) și după fiecare salvare.
 * Ce a introdus instalatorul (Instalation_Litres, ContorNr) vine separat, ca „edits”, și suprascrie valorile din SCADA.
 */
export type InstData = { gen: string; head: number; id: string[]; nm: string[]; cn: string[]; ia: (number | null)[]; vol: (number | null)[]; il: (number | null)[]; vl: (number | null)[]; mi: (number | null)[] };

const fromWire = (w: InstWire): InstData => ({ gen: w.gen, head: w.head, id: w.id, nm: w.nm, cn: w.cn, ia: w.ia, vol: w.vol, il: w.il, vl: w.vl, mi: w.mi });

/** Rândurile schimbate (după id) se suprascriu, cele noi se adaugă la sfârșit. */
function merge(d: InstData, w: InstWire): InstData {
  const o: InstData = { gen: d.gen, head: Math.max(d.head, w.head), id: d.id.slice(), nm: d.nm.slice(), cn: d.cn.slice(), ia: d.ia.slice(), vol: d.vol.slice(), il: d.il.slice(), vl: d.vl.slice(), mi: d.mi.slice() };
  const at = new Map<string, number>();
  o.id.forEach((x, i) => at.set(x, i));
  for (let k = 0; k < w.id.length; k++) {
    let i = at.get(w.id[k]);
    if (i === undefined) { i = o.id.length; at.set(w.id[k], i); o.id.push(w.id[k]); }
    o.nm[i] = w.nm[k]; o.cn[i] = w.cn[k]; o.ia[i] = w.ia[k]; o.vol[i] = w.vol[k]; o.il[i] = w.il[k]; o.vl[i] = w.vl[k]; o.mi[i] = w.mi[k];
  }
  return o;
}

/** Valorile din tabel: ce a introdus instalatorul la noi are prioritate față de SCADA (aceeași regulă ca în formular). */
export function withEdits(d: InstData, edits: InstEdits): InstData {
  const keys = Object.keys(edits);
  if (!keys.length) return d;
  const at = new Map<string, number>();
  d.id.forEach((x, i) => at.set(x, i));
  const il = d.il.slice(), cn = d.cn.slice();
  for (const k of keys) {
    const i = at.get(k);
    if (i === undefined) continue;
    const e = edits[k];
    if (e.l !== undefined) il[i] = e.l;
    if (e.c !== undefined) cn[i] = e.c;
  }
  return { ...d, il, cn };
}

const POLL_MS = 90_000;

export function useInstallerStore(): { ds: InstData | null; edits: InstEdits; error: boolean; refresh: () => void } {
  const [ds, setDs] = useState<InstData | null>(null);
  const [edits, setEdits] = useState<InstEdits>({});
  const [error, setError] = useState(false);
  const cur = useRef<InstData | null>(null);
  useEffect(() => { cur.current = ds; });

  const loadEdits = useCallback(async () => {
    try {
      const r = await fetch("/api/installer/edits", { cache: "no-store" });
      if (r.ok) setEdits(((await r.json()) as { edits: InstEdits }).edits);
    } catch { /* fără rețea: rămân valorile de până acum */ }
  }, []);

  const loadFull = useCallback(async () => {
    const r = await fetch("/api/installer/dataset"); // fără cache: „no-cache” din răspuns cere doar validare (304 când e aceeași versiune)
    if (r.status === 401) { window.location.replace("/login"); return; }
    if (!r.ok) throw new Error(String(r.status));
    setDs(fromWire((await r.json()) as InstWire)); setError(false);
  }, []);

  const poll = useCallback(async () => {
    try {
      const d = cur.current;
      if (!d) { await loadFull(); return; }
      const r = await fetch(`/api/installer/dataset?gen=${encodeURIComponent(d.gen)}&since=${d.head}`, { cache: "no-store" });
      if (r.status === 401) { window.location.replace("/login"); return; }
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as InstWire | { full: true };
      if ("full" in j && j.full === true && !("id" in j)) { await loadFull(); return; }
      const w = j as InstWire;
      if (w.id.length) setDs(merge(d, w));
      else if (w.head > d.head) setDs({ ...d, head: w.head });
    } catch { if (!cur.current) setError(true); }
  }, [loadFull]);

  useEffect(() => {
    const t = setTimeout(() => { void poll(); void loadEdits(); }, 0);
    const iv = setInterval(() => { void poll(); void loadEdits(); }, POLL_MS);
    const vis = () => { if (document.visibilityState === "visible") { void poll(); void loadEdits(); } };
    document.addEventListener("visibilitychange", vis);
    return () => { clearTimeout(t); clearInterval(iv); document.removeEventListener("visibilitychange", vis); };
  }, [poll, loadEdits]);

  const refresh = useCallback(() => { void poll(); void loadEdits(); }, [poll, loadEdits]);
  return { ds, edits, error, refresh };
}
