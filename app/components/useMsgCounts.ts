"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Mesajele pe zi ale contoarelor (API /api/meters/messages; numărătoarea e în lib/meter-msgs.ts), pentru coloana «Mesaje / zi» din tabel și clasamentul «Mesaje».
 * Ziua aleasă se ține minte în browser. Pentru tabel se cer doar contoarele din fereastra vizibilă (cel mult 150 odată, după o scurtă pauză la derulare),
 * iar răspunsurile se rețin 5 minute (datele se schimbă doar la sincronizarea orară).
 */
const KEY = "mg:msgday";
const EVT = "mg:msgday-change";
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dm = (ms: number) => new Date(ms).toISOString().slice(5, 10).split("-").reverse().join(".");

/** zilele de ales: azi (în curs), ieri, apoi încă 12 zile înapoi (zile UTC, ca în restul aplicației) */
export function dayOptions(now: number): { v: string; label: string }[] {
  const t = Math.floor(now / DAY) * DAY;
  const out = [{ v: "today", label: "Azi (în curs)" }, { v: "yesterday", label: "Ieri" }];
  for (let i = 2; i <= 13; i++) out.push({ v: iso(t - i * DAY), label: `${dm(t - i * DAY)}` });
  return out;
}

export function useMsgDay(): [string, (d: string) => void] {
  const [day, setDay] = useState("yesterday");
  useEffect(() => {
    const read = () => { try { const v = localStorage.getItem(KEY); if (v && (v === "today" || v === "yesterday" || /^\d{4}-\d{2}-\d{2}$/.test(v))) setDay(v); } catch { /* fără stocare locală */ } };
    const t = setTimeout(read, 0);
    window.addEventListener(EVT, read);
    return () => { clearTimeout(t); window.removeEventListener(EVT, read); };
  }, []);
  const set = useCallback((d: string) => {
    setDay(d);
    try { localStorage.setItem(KEY, d); window.dispatchEvent(new Event(EVT)); } catch { /* alegerea nu se reține */ }
  }, []);
  return [day, set];
}

type Entry = { at: number; v: number | null };
const cache = new Map<string, Map<string, Entry>>(); // zi → id → mesaje
const TTL = 5 * 60_000;

/** Mesajele (în ziua `day`) pentru `ids`; lipsă = încă se încarcă. */
export function useMsgCounts(enabled: boolean, ids: string[], day: string): { get: (id: string) => number | null | undefined; loading: boolean } {
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);
  const key = ids.join(",");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!enabled || !key) return;
    const m = cache.get(day) ?? new Map<string, Entry>();
    cache.set(day, m);
    const now = Date.now();
    const need = key.split(",").filter((id) => { const e = m.get(id); return !e || now - e.at > TTL; });
    if (need.length === 0) return;
    const ac = new AbortController();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        for (let i = 0; i < need.length; i += 150) {
          const r = await fetch(`/api/meters/messages?day=${encodeURIComponent(day)}&ids=${need.slice(i, i + 150).join(",")}`, { signal: ac.signal });
          if (!r.ok) break;
          const d = (await r.json()) as { counts: Record<string, number | null> };
          const at = Date.now();
          for (const [id, v] of Object.entries(d.counts)) m.set(id, { at, v });
          bump((n) => n + 1);
        }
      } catch { /* derulare rapidă: cererea veche se oprește */ } finally { if (!ac.signal.aborted) setLoading(false); }
    }, 220);
    return () => { ac.abort(); if (timer.current) clearTimeout(timer.current); };
  }, [enabled, key, day]);
  const get = useCallback((id: string) => cache.get(day)?.get(id)?.v, [day]);
  return { get, loading };
}
