"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceId, SourceWire } from "@/lib/source-shared";
import { SourceStore, type SourceSnapshot } from "@/lib/source-store";

/**
 * Lista unei surse (lorawandb / getmgdb) în browser, pe aceleași trei straturi ca la pagina principală:
 *   1. memorie  — rămâne cât timp fila e deschisă: la întoarcerea pe pagină apare instant;
 *   2. IndexedDB — vectorii tipizați se salvează ca atare: după un refresh lista apare în zeci de ms;
 *   3. server    — o descărcare completă (gzip + ETag) doar când s-a schimbat ceva; altfel „304 Not Modified”, fără corp.
 * O copie veche nu e „greșită”, doar depășită: o arătăm imediat și o înlocuim când serverul are alta.
 */
const IDB_BASE = "mg-cache-s"; // prefixul „mg-cache” permite ștergerea la ieșirea din cont (vezi clearMeterCaches)
const POLL_MS = 60_000;

type Stored = { v: 1; s: SourceSnapshot };
export type SourceOrigin = "memorie" | "IndexedDB" | "server" | "";
export type SourceInfo = { at: number; kind: "noop" | "full" };

const memo = new Map<string, SourceStore>(); // STRATUL 1 (în browser): „utilizator:sursă”
export function clearSourceMemo(): void {
  memo.clear();
}

/* ---------- IndexedDB ---------- */
const openDb = (user: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(`${IDB_BASE}:${user}`, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function idbGet(user: string, source: SourceId): Promise<Stored | undefined> {
  try {
    const db = await openDb(user);
    try {
      return await new Promise<Stored | undefined>((resolve) => {
        const r = db.transaction("kv").objectStore("kv").get(source);
        r.onsuccess = () => resolve(r.result as Stored | undefined);
        r.onerror = () => resolve(undefined);
      });
    } finally {
      db.close();
    }
  } catch {
    return undefined; // fără IndexedDB (mod privat etc.): merge și fără cache local
  }
}

async function idbSet(user: string, source: SourceId, value: Stored): Promise<void> {
  try {
    const db = await openDb(user);
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, source);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } finally {
      db.close();
    }
  } catch {
    /* ignorat */
  }
}

function persistLater(user: string, store: SourceStore): void {
  const run = () => void idbSet(user, store.source, { v: 1, s: store.snapshot() });
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 500);
}

const validSnapshot = (s: SourceSnapshot | undefined, source: SourceId): s is SourceSnapshot =>
  !!s && s.source === source && Array.isArray(s.cols) && typeof s.etag === "string" && typeof s.n === "number" && !!s.codes && !!s.nums && !!s.texts && !!s.dict;

async function readJson<T>(res: Response): Promise<T> {
  if (res.body && (res.headers.get("content-type") ?? "").includes("gzip")) {
    return JSON.parse(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text()) as T;
  }
  return (await res.json()) as T;
}

/* ---------- hook ---------- */
export function useSourceStore(opts: { userId: string; source: SourceId; live: boolean }) {
  const { userId, source, live } = opts;
  const key = `${userId}:${source}`;
  const [store, setStore] = useState<SourceStore | null>(() => memo.get(key) ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(() => (memo.has(key) ? "ready" : "loading"));
  const [syncing, setSyncing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [origin, setOrigin] = useState<SourceOrigin>(() => (memo.has(key) ? "memorie" : ""));
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const ref = useRef<{ store: SourceStore | null; busy: boolean }>({ store: memo.get(key) ?? null, busy: false });

  const sync = useCallback(async () => {
    const r = ref.current;
    if (r.busy) return;
    r.busy = true;
    setSyncing(true);
    try {
      const st = r.store;
      const url = `/api/sources/${source}/dataset${typeof DecompressionStream === "undefined" ? "?enc=json" : ""}`;
      // cu o copie la îndemână întrebăm serverul doar „s-a schimbat?” (If-None-Match ⇒ 304 fără corp)
      const res = await fetch(url, st ? { headers: { "If-None-Match": st.etag }, cache: "no-store" } : undefined);
      if (res.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (res.status === 304) {
        setInfo({ at: Date.now(), kind: "noop" });
        setStatus("ready");
        setOffline(false);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const next = SourceStore.fromWire(await readJson<SourceWire>(res));
      if (st && st.etag === next.etag) {
        setInfo({ at: Date.now(), kind: "noop" });
        setStatus("ready");
        setOffline(false);
        return;
      }
      r.store = next;
      memo.set(key, next);
      setStore(next);
      setOrigin("server");
      setInfo({ at: Date.now(), kind: "full" });
      setStatus("ready");
      setOffline(false);
      persistLater(userId, next);
    } catch (e) {
      console.error(`[${source}] sincronizare eșuată:`, e);
      // fără rețea / server căzut: păstrăm ce avem (poate fi depășit, dar nu e greșit)
      if (ref.current.store) setOffline(true);
      else setStatus("error");
    } finally {
      r.busy = false;
      setSyncing(false);
    }
  }, [source, userId, key]);

  // pornire: memorie → IndexedDB → server
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!ref.current.store) {
        const saved = await idbGet(userId, source);
        if (!alive) return;
        if (saved?.v === 1 && validSnapshot(saved.s, source)) {
          try {
            const st = SourceStore.fromSnapshot(saved.s);
            ref.current.store = st;
            memo.set(key, st);
            setStore(st);
            setOrigin("IndexedDB");
            setStatus("ready");
          } catch {
            /* copie stricată: o ignorăm și cerem lista de la server */
          }
        }
      }
      if (alive) await sync();
    })();
    return () => {
      alive = false;
    };
  }, [userId, source, key, sync]);

  // „live”: întrebăm serverul cât timp fila e vizibilă (răspunsul fără modificări are câteva zeci de octeți)
  useEffect(() => {
    if (!live) return;
    const tick = () => {
      if (document.visibilityState === "visible") void sync();
    };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [live, sync]);

  return { store, status, syncing, offline, origin, info, refresh: sync };
}
