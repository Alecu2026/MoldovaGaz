"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DatasetWire, DeltaFull, DeltaWire } from "@/lib/meter-shared";
import { MeterStore, type Snapshot } from "@/lib/meter-store";
import { clearSourceMemo } from "./useSourceStore";

/**
 * Lista completă de contoare în browser, pe TREI straturi (peste cache-ul serverului din lib/services/meter-dataset.ts):
 *   1. memorie  — obiectul `memo` de mai jos: rămâne cât timp fila e deschisă; la întoarcerea pe pagină apare instant, fără IndexedDB, fără decodare;
 *   2. IndexedDB — vectorii tipizați se salvează ca atare (fără JSON.parse): după un refresh / o zi mai târziu lista apare în zeci de ms;
 *   3. server    — o singură descărcare completă (gzip + ETag/304) când nu avem nimic compatibil, apoi DOAR delta: „dă-mi ce s-a schimbat după seq X”.
 * O copie veche nu e „greșită”, doar depășită: o arătăm imediat și o aducem la zi cu delta.
 */

const IDB_BASE = "mg-cache-m";
const IDB_KEY = "meters";
const POLL_MS = 30_000;

type Stored = { v: 4; s: Snapshot };
export type SyncKind = "noop" | "delta" | "full";
export type Origin = "memorie" | "IndexedDB" | "server" | "";
export type SyncInfo = { at: number; kind: SyncKind; added: number };

let memo: { user: string; store: MeterStore } | null = null; // STRATUL 1 (în browser)

/* ---------- IndexedDB ---------- */
const dbName = (user: string) => `${IDB_BASE}:v3:${user}`; // v3: fl pe 16 biți, coloanele ac / ia (activitate din SCADA)

function openDb(user: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(user), 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(user: string): Promise<Stored | undefined> {
  try {
    const db = await openDb(user);
    try {
      return await new Promise<Stored | undefined>((resolve) => {
        const r = db.transaction("kv").objectStore("kv").get(IDB_KEY);
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

async function idbSet(user: string, value: Stored): Promise<void> {
  try {
    const db = await openDb(user);
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, IDB_KEY);
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

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(user: string, store: MeterStore, delay = 3000) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const run = () => void idbSet(user, { v: 4, s: store.snapshot() });
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 });
    else run();
  }, delay);
}

/** La ieșire din cont: lista (cu date despre consumatori) nu rămâne în browser pentru următorul utilizator al calculatorului. */
export async function clearMeterCaches(): Promise<void> {
  memo = null;
  clearSourceMemo();
  if (persistTimer) clearTimeout(persistTimer);
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs
        .filter((d) => d.name?.startsWith("mg-cache"))
        .map(
          (d) =>
            new Promise<void>((resolve) => {
              const r = indexedDB.deleteDatabase(d.name as string);
              r.onsuccess = r.onerror = r.onblocked = () => resolve();
            }),
        ),
    );
  } catch {
    /* ignorat */
  }
}

/** Lista vine gzip (application/gzip, memorată pe server) și se decomprimă aici; fără DecompressionStream cerem JSON simplu. */
const DATASET_URL = typeof DecompressionStream === "undefined" ? "/api/meters/dataset?enc=json" : "/api/meters/dataset";
async function readJson<T>(res: Response): Promise<T> {
  if (res.body && (res.headers.get("content-type") ?? "").includes("gzip")) {
    return JSON.parse(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text()) as T;
  }
  return (await res.json()) as T;
}

/* ---------- hook ---------- */
export function useMeterStore(opts: { userId: string; warm: { gen: string; head: number } | null; live: boolean }) {
  const { userId, warm, live } = opts;
  const [store, setStore] = useState<MeterStore | null>(() => (memo?.user === userId ? memo.store : null));
  const [rev, setRev] = useState(0); // lista se modifică pe loc (delta): rev declanșează re-randarea și e cheie de memoizare
  const [status, setStatus] = useState<"loading" | "ready" | "error">(() => (memo?.user === userId ? "ready" : "loading"));
  const [syncing, setSyncing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [origin, setOrigin] = useState<Origin>(() => (memo?.user === userId ? "memorie" : ""));
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const ref = useRef<{ store: MeterStore | null; busy: boolean; warmUsed: boolean; user: string }>({
    store: memo?.user === userId ? memo.store : null,
    busy: false,
    warmUsed: false,
    user: userId,
  });
  const warmRef = useRef(warm);
  useEffect(() => {
    warmRef.current = warm;
  });

  const sync = useCallback(async () => {
    const r = ref.current;
    if (r.busy) return;
    r.busy = true;
    setSyncing(true);
    try {
      const st = r.store;
      const w = warmRef.current;
      const firstSync = !r.warmUsed;
      r.warmUsed = true;

      // pagina a venit deja cu versiunea curentă și o avem ⇒ nu e nimic de cerut (zero cereri)
      if (st && firstSync && w && st.gen === w.gen && st.head === w.head) {
        setInfo({ at: Date.now(), kind: "noop", added: 0 });
        setStatus("ready");
        setOffline(false);
        return;
      }

      if (st) {
        const d0 = st.dict;
        const qs = new URLSearchParams({
          gen: st.gen, after: String(st.head),
          ap: String(d0.ap.length), gw: String(d0.gw.length), ty: String(d0.ty.length), br: String(d0.br.length), ct: String(d0.ct.length), pf: String(d0.pf.length),
        });
        const res = await fetch(`/api/meters/delta?${qs}`, { cache: "no-store" });
        if (res.status === 401) {
          window.location.replace("/login");
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as DeltaWire | DeltaFull;
        if (!("full" in d)) {
          const changed = st.applyDelta(d);
          if (changed >= 0) {
            memo = { user: r.user, store: st };
            setInfo({ at: Date.now(), kind: changed > 0 ? "delta" : "noop", added: changed });
            setStatus("ready");
            setOffline(false);
            if (changed > 0) {
              setRev((v) => v + 1);
              schedulePersist(r.user, st);
            }
            return;
          }
        }
        // generație schimbată / cursor care nu se potrivește ⇒ lista întreagă
      }

      const res = await fetch(DATASET_URL); // cache-ul HTTP al browserului revalidează singur cu If-None-Match
      if (res.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const next = MeterStore.fromWire(await readJson<DatasetWire>(res));
      r.store = next;
      setStore(next);
      memo = { user: r.user, store: next };
      setOrigin("server");
      setInfo({ at: Date.now(), kind: "full", added: next.n });
      setStatus("ready");
      setOffline(false);
      setRev((v) => v + 1);
      schedulePersist(r.user, next, 500);
    } catch (e) {
      console.error("[meters] sincronizare eșuată:", e);
      // fără rețea / server căzut: păstrăm ce avem (poate fi depășit, dar nu e greșit)
      if (ref.current.store) setOffline(true);
      else setStatus("error");
    } finally {
      r.busy = false;
      setSyncing(false);
    }
  }, []);

  // pornire: memorie → IndexedDB → server
  useEffect(() => {
    let alive = true;
    ref.current.user = userId;
    (async () => {
      if (!ref.current.store) {
        const saved = await idbGet(userId);
        if (!alive) return;
        if (saved?.v === 4 && saved.s?.ts instanceof Float64Array && saved.s.la instanceof Float64Array && saved.s.n >= 0) {
          try {
            const st = MeterStore.fromSnapshot(saved.s);
            ref.current.store = st;
            setStore(st);
            memo = { user: userId, store: st };
            setOrigin("IndexedDB");
            setStatus("ready");
            setRev((v) => v + 1);
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
  }, [userId, sync]);

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

  return { store, rev, status, syncing, offline, origin, info, refresh: sync };
}
