import fs from "node:fs";
import path from "node:path";
import type { Db } from "mongodb";
import { decodeImage, fullPx, PHOTO_COLLECTION, photoDir, photoPath, processImage } from "./photos";
import { tb } from "./thingsboard";

/**
 * Extragerea pozelor din SCADA (doar CITIRE: GET /values/attributes?keys=image, câte un contor pe cerere), decodare, micșorare și scriere pe disc (lib/photos.ts).
 *  - se poate opri oricând (Ctrl+C / pm2 stop) și se reia de unde a rămas: starea fiecărui contor e în `meter_photos`;
 *  - ritm blând pe SCADA: PHOTO_CONCURRENCY cereri deodată (implicit 3), PHOTO_PAUSE_MS între cereri la fiecare (implicit 150);
 *  - contoarele fără poză („none”) se verifică din nou după NONE_RETRY_DAYS zile, cele cu eroare după câteva minute (de cel mult MAX_TRIES ori);
 *  - se oprește singură dacă pe disc mai rămân sub PHOTO_MIN_FREE_GB GB, sau dacă SCADA nu răspunde minute la rând.
 */
type PhotoDoc = { _id: string; st: "ok" | "none" | "err"; at: Date; ts?: number; b?: number; w?: number; h?: number; src?: number; mx?: number; n?: number; msg?: string };
export type PullStats = { total: number; todo: number; ok: number; none: number; err: number; bytes: number; srcBytes: number; ms: number; stopped: string | null };
type Attr = { key?: string; value?: unknown; lastUpdateTs?: number };

const DAY = 86_400_000;
export const NONE_RETRY_DAYS = 7;
export const MAX_TRIES = 5;
const ERR_RETRY_MS = 10 * 60_000;
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Care contoare mai trebuie (re)verificate: fără stare, cu poză păstrată la o rezoluție mai mică decât `px`, cu eroare mai veche de 10 min (și sub MAX_TRIES încercări), fără poză de peste NONE_RETRY_DAYS zile; sau toate, cu `refresh`. */
export function pendingIds(all: string[], done: Map<string, Pick<PhotoDoc, "st" | "at" | "n" | "mx">>, now: number, refresh = false, px = fullPx()): string[] {
  return all.filter((id) => {
    const d = done.get(id);
    if (!d || refresh) return true;
    const age = now - d.at.getTime();
    if (d.st === "err") return (d.n ?? 1) < MAX_TRIES && age >= ERR_RETRY_MS;
    if (d.st === "none") return age >= NONE_RETRY_DAYS * DAY;
    return (d.mx ?? 0) < px; // poză păstrată la o rezoluție mai mică decât cea cerută acum: se reface (o singură dată)
  });
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

export async function pullPhotos(db: Db, opts: { limit?: number; refresh?: boolean; log?: (m: string) => void; shouldStop?: () => boolean } = {}): Promise<PullStats> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const conc = Math.min(8, Math.floor(num(process.env.PHOTO_CONCURRENCY, 3)));
  const pause = Number(process.env.PHOTO_PAUSE_MS ?? 150) || 0;
  const minFree = num(process.env.PHOTO_MIN_FREE_GB, 3) * 1e9;
  const dir = photoDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const coll = db.collection<PhotoDoc>(PHOTO_COLLECTION);

  const all = (await db.collection(process.env.METERS_COLLECTION || "meters").find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()).map((d) => String(d._id));
  const done = new Map<string, PhotoDoc>();
  for await (const d of coll.find({}, { projection: { _id: 1, st: 1, at: 1, n: 1, mx: 1 } })) done.set(String(d._id), d as PhotoDoc);
  let todo = pendingIds(all, done, Date.now(), opts.refresh);
  const pending = todo.length;
  if (opts.limit && opts.limit > 0) todo = todo.slice(0, opts.limit);
  log(`poze: ${all.length} contoare, ${pending} de verificat${opts.limit ? ` (acum doar primele ${todo.length})` : ""}; ${conc} cereri deodată, pauză ${pause} ms; director ${dir}`);

  const st: PullStats = { total: all.length, todo: todo.length, ok: 0, none: 0, err: 0, bytes: 0, srcBytes: 0, ms: 0, stopped: null };
  let next = 0, fails = 0, lastOkAt = Date.now(), processed = 0;
  const save = (id: string, doc: Omit<PhotoDoc, "_id">) => coll.updateOne({ _id: id }, { $set: doc }, { upsert: true });

  async function one(id: string): Promise<void> {
    const prev = done.get(id);
    try {
      const r = await tb<Attr[]>(`/api/plugins/telemetry/DEVICE/${id}/values/attributes?keys=image`, { timeoutMs: 180_000, retries: 2 });
      fails = 0; lastOkAt = Date.now();
      const a = Array.isArray(r) ? r.find((x) => x.key === "image") : undefined;
      const buf = a ? decodeImage(a.value) : null;
      if (!a || !buf) {
        await save(id, { st: "none", at: new Date(), ...(a ? { msg: "atribut `image` fără o imagine validă" } : {}) });
        st.none++;
        return;
      }
      const p = await processImage(buf);
      await writeAtomic(photoPath(id, false, dir), p.full);
      await writeAtomic(photoPath(id, true, dir), p.thumb);
      await save(id, { st: "ok", at: new Date(), ts: Number(a.lastUpdateTs) || 0, b: p.full.length, w: p.w, h: p.h, src: buf.length, mx: fullPx() });
      st.ok++; st.bytes += p.full.length + p.thumb.length; st.srcBytes += buf.length;
    } catch (e) {
      fails++;
      const status = (e as { status?: number }).status;
      if (status === 404) { await save(id, { st: "none", at: new Date(), msg: "dispozitivul nu mai există în SCADA" }); st.none++; return; }
      await save(id, { st: "err", at: new Date(), n: (prev?.st === "err" ? prev.n ?? 1 : 0) + 1, msg: String((e as Error).message ?? e).slice(0, 200) });
      st.err++;
    }
  }

  async function worker(): Promise<void> {
    while (!st.stopped) {
      if (opts.shouldStop?.()) { st.stopped = "oprit la cerere (se reia de unde a rămas)"; return; }
      const i = next++;
      if (i >= todo.length) return;
      if (fails >= 10) { // SCADA nu răspunde: aștept, apoi renunț dacă nu revine
        if (Date.now() - lastOkAt > 5 * 60_000) { st.stopped = "SCADA nu a răspuns 5 minute la rând: m-am oprit (se reia la următoarea pornire)"; return; }
        await new Promise((r) => setTimeout(r, 30_000));
      }
      if (processed % 100 === 0) {
        try { const s = await fs.promises.statfs(dir); if (Number(s.bavail) * Number(s.bsize) < minFree) { st.stopped = `pe disc au rămas sub ${Math.round(minFree / 1e9)} GB liberi: m-am oprit`; return; } } catch { /* nu se poate citi: continui */ }
      }
      processed++;
      await one(todo[i]);
      if (pause) await new Promise((r) => setTimeout(r, pause));
    }
  }

  const tick = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    const left = todo.length - Math.min(next, todo.length);
    log(`poze: ${st.ok + st.none + st.err}/${todo.length} (cu poză ${st.ok}, fără ${st.none}, erori ${st.err}); ${(st.srcBytes / 1e6).toFixed(0)} MB trași → ${(st.bytes / 1e6).toFixed(0)} MB pe disc; ${((st.ok + st.none + st.err) / s).toFixed(1)} contoare/s; au rămas ${left}`);
  }, 30_000);
  try {
    await Promise.all(Array.from({ length: conc }, () => worker()));
  } finally {
    clearInterval(tick);
  }
  st.ms = Date.now() - t0;
  log(`poze: gata${st.stopped ? ` (${st.stopped})` : ""} — cu poză ${st.ok}, fără ${st.none}, erori ${st.err}; ${(st.srcBytes / 1e6).toFixed(0)} MB trași → ${(st.bytes / 1e6).toFixed(0)} MB pe disc, ${Math.round(st.ms / 1000)} s`);
  return st;
}
