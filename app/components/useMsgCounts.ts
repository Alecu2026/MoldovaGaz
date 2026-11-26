"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MeterStore } from "@/lib/meter-store";

/**
 * Mesajele trimise de contoare (de câte ori a trimis fiecare date; API /api/meters/messages, numărătoarea e în lib/meter-msgs.ts), pentru coloana «Mesaje / zi» din tabel și clasamentul «Mesaje».
 * Perioada aleasă (o zi, ultimele 3 / 7 / 30 de zile, un interval ales) se ține minte în browser. Pentru tabel se cer doar contoarele din fereastra vizibilă (cel mult 150 odată,
 * după o scurtă pauză la derulare); pentru SORTARE după mesaje se cer valorile tuturor contoarelor o singură dată (vezi `useMsgAll`). Răspunsurile se rețin 5 minute.
 */
const KEY = "mg:msgday";
const EVT = "mg:msgday-change";
const DAY = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dm = (ms: number) => new Date(ms).toISOString().slice(5, 10).split("-").reverse().join(".");
const OK = /^(today|yesterday|\d{4}-\d{2}-\d{2}|\d{1,2}d|r:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2})$/;

export type PeriodOpt = { v: string; label: string };
/** Opțiunile din meniu, pe grupe: perioade (zile întregi, fără azi), zile, interval ales. Zilele sunt zile UTC (ca în restul aplicației). */
export function periodOptions(now: number): { perioade: PeriodOpt[]; zile: PeriodOpt[] } {
  const t = Math.floor(now / DAY) * DAY;
  const zile: PeriodOpt[] = [{ v: "today", label: "Azi (în curs)" }, { v: "yesterday", label: "Ieri" }];
  for (let i = 2; i <= 13; i++) zile.push({ v: iso(t - i * DAY), label: dm(t - i * DAY) });
  return { perioade: [{ v: "3d", label: "Ultimele 3 zile" }, { v: "7d", label: "Ultima săptămână (7 zile)" }, { v: "30d", label: "Ultima lună (30 de zile)" }], zile };
}
/** Perioada într-un text scurt (pentru titluri). */
export function periodLabel(v: string, now: number): string {
  const all = periodOptions(now);
  const o = [...all.perioade, ...all.zile].find((x) => x.v === v);
  if (o) return o.label.toLowerCase();
  if (v.startsWith("r:")) { const [, a, b] = v.split(":"); return `${a.split("-").reverse().join(".")} – ${b.split("-").reverse().join(".")}`; }
  return v;
}

export function useMsgPeriod(): [string, (d: string) => void] {
  const [p, setP] = useState("yesterday");
  useEffect(() => {
    const read = () => { try { const v = localStorage.getItem(KEY); if (v && OK.test(v)) setP(v); } catch { /* fără stocare locală */ } };
    const t = setTimeout(read, 0);
    window.addEventListener(EVT, read);
    return () => { clearTimeout(t); window.removeEventListener(EVT, read); };
  }, []);
  const set = useCallback((d: string) => {
    setP(d);
    try { localStorage.setItem(KEY, d); window.dispatchEvent(new Event(EVT)); } catch { /* alegerea nu se reține */ }
  }, []);
  return [p, set];
}

type Entry = { at: number; v: [number, number] | null };
const cache = new Map<string, Map<string, Entry>>(); // perioadă → id → [total, zile]
const TTL = 5 * 60_000;

/** [total, zile numărate] pe perioadă pentru `ids`; undefined = încă se încarcă, null = nenumărat. */
export function useMsgCounts(enabled: boolean, ids: string[], period: string): { get: (id: string) => [number, number] | null | undefined; loading: boolean } {
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);
  const key = ids.join(",");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!enabled || !key) return;
    const m = cache.get(period) ?? new Map<string, Entry>();
    cache.set(period, m);
    const now = Date.now();
    const need = key.split(",").filter((id) => { const e = m.get(id); return !e || now - e.at > TTL; });
    if (need.length === 0) return;
    const ac = new AbortController();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        for (let i = 0; i < need.length; i += 150) {
          const r = await fetch(`/api/meters/messages?p=${encodeURIComponent(period)}&ids=${need.slice(i, i + 150).join(",")}`, { signal: ac.signal });
          if (!r.ok) break;
          const d = (await r.json()) as { counts: Record<string, [number, number] | null> };
          const at = Date.now();
          for (const [id, v] of Object.entries(d.counts)) m.set(id, { at, v });
          bump((n) => n + 1);
        }
      } catch { /* derulare rapidă: cererea veche se oprește */ } finally { if (!ac.signal.aborted) setLoading(false); }
    }, 220);
    return () => { ac.abort(); if (timer.current) clearTimeout(timer.current); };
  }, [enabled, key, period]);
  const get = useCallback((id: string) => cache.get(period)?.get(id)?.v, [period]);
  return { get, loading };
}

type All = { gen: string; n: number; probes: [number, string][]; t: string; d: string };
const b64 = (s: string): Uint8Array => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

/**
 * Media de mesaje pe zi a TUTUROR contoarelor din lista ta, ca vector aliniat cu rândurile (NaN = nenumărat), pentru sortarea după coloana «Mesaje / zi».
 * Valorile vin pe poziție; înainte să fie folosite se verifică generația listei și câteva (poziție, id): dacă lista din browser nu are aceeași ordine ca la server, nu se folosesc
 * (mai bine nesortat decât cu valorile pe contoarele greșite). Se cer doar când sortezi după mesaje.
 */
export function useMsgAll(enabled: boolean, store: MeterStore | null, rev: number, period: string): Float32Array | null {
  const [res, setRes] = useState<{ key: string; all: All | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    const key = period;
    void fetch(`/api/meters/messages?p=${encodeURIComponent(period)}&all=1`, { signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<All>) : null))
      .then((all) => { if (!ac.signal.aborted) setRes({ key, all }); })
      .catch(() => undefined);
    return () => ac.abort();
  }, [enabled, period]);
  void rev;
  if (!enabled || !store || !res || res.key !== period || !res.all) return null;
  const a = res.all;
  if (store.gen !== a.gen || a.probes.some(([pos, id]) => pos < store.n && store.id[pos] !== id)) return null;
  const t = b64(a.t), d = b64(a.d), n = Math.min(a.n, store.n);
  const out = new Float32Array(store.n).fill(NaN);
  for (let i = 0; i < n; i++) if (d[i] > 0) out[i] = (t[i * 2] | (t[i * 2 + 1] << 8)) / d[i];
  return out;
}
