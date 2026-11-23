import "server-only";
import type { Document, ObjectId } from "mongodb";
import { appendReadingsFor } from "../meter-readings";
import { mergeDerive, mergeMsgs, parseMessage, type IntegrationMsg, type MeterDocIng } from "../integration";
import { COLLECTIONS, col, getDb } from "../mongo";
import { bumpMeterEpoch, getStore } from "./meter-dataset";

/**
 * INTEGRARE — primirea mesajelor de contor direct de la rețeaua LoRaWAN / antene, FĂRĂ să se piardă niciunul.
 *
 *  1. `accept`: mesajele validate se salvează DURABIL într-o „cutie de intrare” (colecția `integration_inbox`, scriere cu jurnal) și abia APOI se răspunde „primit”.
 *     Dacă salvarea eșuează, nu se răspunde cu succes ⇒ expeditorul reîncearcă. Dacă cutia e prea plină, se răspunde 503 + Retry-After (presiune înapoi, nu pierdere).
 *  2. Un proces de fundal (pornit din instrumentation.ts) golește cutia în pachete: îmbină mesajele aceluiași contor în ordinea sosirii, le aplică pe `meters`
 *     (aceeași derivare ca la sincronizarea din SCADA), adaugă citirea în istoricul propriu (`meter_readings`) și abia apoi șterge mesajele din cutie.
 *  3. Aplicarea e IDEMPOTENTĂ (telemetria cu momentul cel mai nou câștigă, citirile se adaugă doar dacă sunt mai noi, același conținut nu se rescrie): dacă serverul
 *     cade între aplicare și ștergere, mesajele se aplică din nou la repornire fără efecte duble. Ce nu se poate aplica (eroare de date) merge în `integration_dead`,
 *     nu blochează restul. Eroare de bază de date ⇒ pauză cu întârziere crescătoare, mesajele rămân în cutie.
 */
export const INBOX = process.env.INTEGRATION_INBOX_COLLECTION || "integration_inbox";
export const DEAD = process.env.INTEGRATION_DEAD_COLLECTION || "integration_dead";
const MAX_INBOX = Number(process.env.INTEGRATION_MAX_INBOX) > 0 ? Number(process.env.INTEGRATION_MAX_INBOX) : 500_000;
const BATCH = 1000;
const IDLE_MS = 250;

type InboxDoc = { _id: ObjectId; id: string; at: number; m: IntegrationMsg };
type Ev = { at: number; id: string; name: string; status: string };
type State = {
  started: boolean; running: boolean; timer: ReturnType<typeof setTimeout> | null; failDelay: number; lastError: string | null;
  received: number; rejected: number; processed: number; created: number; updated: number; unchanged: number; dead: number; busy: number;
  sec: Map<number, { rx: number; ok: number }>; events: Ev[]; lastBatch: { n: number; ms: number; at: number } | null; batchMs: number[];
  depth: { at: number; n: number }; maps: { gen: string; n: number; names: Map<string, string>; euis: Map<string, string> } | null; indexed: boolean;
};
const g = globalThis as unknown as { __integ?: State };
function st(): State {
  return (g.__integ ??= {
    started: false, running: false, timer: null, failDelay: 0, lastError: null,
    received: 0, rejected: 0, processed: 0, created: 0, updated: 0, unchanged: 0, dead: 0, busy: 0,
    sec: new Map(), events: [], lastBatch: null, batchMs: [], depth: { at: 0, n: 0 }, maps: null, indexed: false,
  });
}
const bucket = (s: State, now: number) => {
  const k = Math.floor(now / 1000);
  let b = s.sec.get(k);
  if (!b) {
    b = { rx: 0, ok: 0 };
    s.sec.set(k, b);
    if (s.sec.size > 180) for (const x of s.sec.keys()) if (x < k - 150) s.sec.delete(x);
  }
  return b;
};
const pushEv = (s: State, e: Ev) => {
  s.events.push(e);
  if (s.events.length > 100) s.events.splice(0, s.events.length - 100);
};

/* ───────── identificarea contorului: id din UUID, sau după nume / devEUI ───────── */
async function resolver(): Promise<{ byName: (n: string) => string | null; byEui: (e: string) => string | null }> {
  const s = st();
  const store = await getStore();
  if (!s.maps || s.maps.gen !== store.gen || s.maps.n !== store.cols.id.length) {
    const names = new Map<string, string>(), euis = new Map<string, string>();
    const c = store.cols;
    for (let i = 0; i < c.id.length; i++) {
      if (c.nm[i]) names.set(c.nm[i], c.id[i]);
      if (c.eu[i]) euis.set(c.eu[i], c.id[i]);
    }
    s.maps = { gen: store.gen, n: c.id.length, names, euis };
  }
  const m = s.maps;
  return { byName: (n) => m.names.get(n) ?? null, byEui: (e) => m.euis.get(e) ?? null };
}

export type AcceptResult = { received: number; accepted: number; errors: { index: number; error: string }[] };
export class BusyError extends Error {
  constructor(public retryAfter: number) { super("cutia de intrare e plină"); }
}

async function depth(): Promise<number> {
  const s = st(), now = Date.now();
  if (now - s.depth.at < 1000) return s.depth.n;
  const n = await (await col(INBOX)).estimatedDocumentCount();
  s.depth = { at: now, n };
  return n;
}

/** Validează și salvează durabil mesajele. Aruncă (⇒ fără răspuns de succes) dacă salvarea eșuează sau cutia e plină. */
export async function accept(items: unknown[]): Promise<AcceptResult> {
  const s = st();
  const now = Date.now();
  const b = bucket(s, now);
  s.received += items.length;
  b.rx += items.length;
  const errors: AcceptResult["errors"] = [];
  const parsed: { index: number; msg: IntegrationMsg }[] = [];
  for (let i = 0; i < items.length; i++) {
    const p = parseMessage(items[i], now);
    if (p.ok) parsed.push({ index: i, msg: p.msg });
    else errors.push({ index: i, error: p.error });
  }
  const docs: { id: string; at: number; m: IntegrationMsg }[] = [];
  if (parsed.length) {
    const r = parsed.some((x) => !x.msg.id) ? await resolver() : null;
    for (const { index, msg } of parsed) {
      const id = msg.id ?? (msg.name && r?.byName(msg.name)) ?? (msg.eui && r?.byEui(msg.eui)) ?? null;
      if (!id) errors.push({ index, error: "contor necunoscut: trimite id (UUID) sau un nume / devEUI existent în aplicație" });
      else docs.push({ id, at: now, m: { ...msg, id } });
    }
  }
  if (docs.length) {
    if ((await depth()) + docs.length > MAX_INBOX) {
      s.busy++;
      throw new BusyError(Math.min(30, 2 + Math.floor((await depth()) / 20_000)));
    }
    const inbox = await col<Document>(INBOX);
    await inbox.insertMany(docs as never, { ordered: false, writeConcern: { w: 1, j: true } });
    s.depth.n += docs.length;
    kick();
  }
  s.rejected += errors.length;
  b.ok += docs.length;
  for (const d of docs.slice(0, 20)) pushEv(s, { at: now, id: d.id, name: d.m.name ?? "", status: "primit" });
  return { received: items.length, accepted: docs.length, errors };
}

/* ───────── procesul care golește cutia ───────── */
async function drainOnce(): Promise<number> {
  const s = st();
  const inbox = await col<InboxDoc>(INBOX);
  const t0 = Date.now();
  const docs = await inbox.find({}).sort({ _id: 1 }).limit(BATCH).toArray();
  if (docs.length === 0) return 0;

  // același contor de mai multe ori în pachet: se îmbină în ordinea sosirii
  const by = new Map<string, IntegrationMsg>();
  for (const d of docs) by.set(d.id, by.has(d.id) ? mergeMsgs(by.get(d.id)!, d.m) : d.m);

  const meters = await col<MeterDocIng>(COLLECTIONS.meters);
  const existing = new Map<string, MeterDocIng>();
  for await (const x of meters.find({ _id: { $in: [...by.keys()] } as never })) existing.set(String(x._id), x);

  const now = new Date();
  const writes: MeterDocIng[] = [];
  const readings: MeterDocIng[] = [];
  const dead: { id: string; error: string; m: IntegrationMsg; at: number }[] = [];
  let created = 0, updated = 0, unchanged = 0;
  for (const [id, msg] of by) {
    try {
      const r = mergeDerive(existing.get(id) ?? null, id, msg, now);
      readings.push(r.doc);
      if (r.status === "unchanged") { unchanged++; continue; }
      r.doc.ing = now.getTime();
      writes.push(r.doc);
      if (r.status === "created") created++; else updated++;
      pushEv(s, { at: now.getTime(), id, name: r.doc.tb.name, status: r.status === "created" ? "nou" : "actualizat" });
    } catch (e) {
      dead.push({ id, error: (e as Error).message.slice(0, 300), m: msg, at: Date.now() });
    }
  }
  if (writes.length) {
    for (let i = 0; i < writes.length; i += 500) {
      await meters.bulkWrite(writes.slice(i, i + 500).map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d as never, upsert: true } })), { ordered: false });
    }
  }
  await appendReadingsFor(await getDb(), readings);
  if (dead.length) await (await col<Document>(DEAD)).insertMany(dead.map((d) => ({ ...d, createdAt: new Date() })) as never);
  if (writes.length) bumpMeterEpoch();
  // abia acum se șterg din cutie (dacă ceva a eșuat mai sus, mesajele rămân și se reiau)
  await inbox.deleteMany({ _id: { $in: docs.map((d) => d._id) } });

  const ms = Date.now() - t0;
  s.processed += docs.length; s.created += created; s.updated += updated; s.unchanged += unchanged; s.dead += dead.length;
  s.lastBatch = { n: docs.length, ms, at: Date.now() };
  s.batchMs.push(ms);
  if (s.batchMs.length > 100) s.batchMs.shift();
  s.depth.n = Math.max(0, s.depth.n - docs.length);
  return docs.length;
}

async function loop(): Promise<void> {
  const s = st();
  if (s.running) return;
  s.running = true;
  try {
    for (;;) {
      const n = await drainOnce();
      s.failDelay = 0;
      s.lastError = null;
      if (n < BATCH) break; // cutia e (aproape) goală; mesajele noi trezesc procesul prin kick()
    }
  } catch (e) {
    s.lastError = (e as Error).message;
    s.failDelay = Math.min(30_000, s.failDelay ? s.failDelay * 2 : 1000);
    console.error("[integration] aplicarea mesajelor a eșuat, reîncerc:", (e as Error).message);
  } finally {
    s.running = false;
    schedule(s.failDelay || IDLE_MS * 4);
  }
}
function schedule(ms: number) {
  const s = st();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void loop();
  }, ms);
  s.timer.unref?.();
}
/** Trezește procesul acum (apelat după ce mesaje noi au intrat în cutie). */
export function kick(): void {
  const s = st();
  if (!s.running) schedule(0);
}

/** Pornește procesul de fundal (o singură dată pe proces). La pornire golește și ce a rămas în cutie dinainte de o repornire. */
export function startIntegrationWorker(): void {
  const s = st();
  if (s.started) return;
  s.started = true;
  void (async () => {
    try {
      const inbox = await col<Document>(INBOX);
      await inbox.createIndex({ id: 1 }); // pentru diagnostic; golirea se face după _id
      await (await col<Document>(DEAD)).createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });
      s.indexed = true;
    } catch (e) {
      console.error("[integration] indecși:", (e as Error).message);
    }
    kick();
  })();
}

export type IntegrationStats = {
  enabled: boolean; startedWorker: boolean; depth: number; oldestAgeMs: number | null; lastError: string | null;
  totals: { received: number; rejected: number; processed: number; created: number; updated: number; unchanged: number; dead: number; busy: number };
  perSecond: { rx: number[]; ok: number[] }; rateRx10: number; rateOk10: number;
  lastBatch: { n: number; ms: number; at: number } | null; batchP50: number | null; batchP95: number | null;
  events: Ev[]; maxInbox: number; deadCount: number;
};
export async function integrationStats(): Promise<IntegrationStats> {
  const s = st();
  const inbox = await col<InboxDoc>(INBOX);
  const [n, oldest, deadCount] = await Promise.all([inbox.estimatedDocumentCount(), inbox.find({}, { projection: { at: 1 } }).sort({ _id: 1 }).limit(1).next(), (await col<Document>(DEAD)).estimatedDocumentCount()]);
  const nowK = Math.floor(Date.now() / 1000);
  const rx: number[] = [], ok: number[] = [];
  for (let k = nowK - 59; k <= nowK; k++) {
    const b = s.sec.get(k);
    rx.push(b?.rx ?? 0);
    ok.push(b?.ok ?? 0);
  }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const sorted = [...s.batchMs].sort((a, b) => a - b);
  const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
  return {
    enabled: (process.env.INTEGRATION_TOKEN ?? "").trim().length >= 24, startedWorker: s.started, depth: n, oldestAgeMs: oldest?.at ? Date.now() - oldest.at : null, lastError: s.lastError,
    totals: { received: s.received, rejected: s.rejected, processed: s.processed, created: s.created, updated: s.updated, unchanged: s.unchanged, dead: s.dead, busy: s.busy },
    perSecond: { rx, ok }, rateRx10: Math.round((sum(rx.slice(-10)) / 10) * 10) / 10, rateOk10: Math.round((sum(ok.slice(-10)) / 10) * 10) / 10,
    lastBatch: s.lastBatch, batchP50: pct(0.5), batchP95: pct(0.95), events: s.events.slice(-40).reverse(), maxInbox: MAX_INBOX, deadCount,
  };
}

/** Verificare fără scriere: validează mesajul și arată ce document ar rezulta (rezumatul derivat). */
export async function checkMessage(x: unknown): Promise<{ ok: true; id: string | null; status: string; summary: unknown } | { ok: false; error: string }> {
  const p = parseMessage(x);
  if (!p.ok) return p;
  const r = p.msg.id || p.msg.name || p.msg.eui ? await resolver() : null;
  const id = p.msg.id ?? (p.msg.name && r?.byName(p.msg.name)) ?? (p.msg.eui && r?.byEui(p.msg.eui)) ?? null;
  if (!id) return { ok: false, error: "contor necunoscut: trimite id (UUID) sau un nume / devEUI existent în aplicație" };
  const meters = await col<MeterDocIng>(COLLECTIONS.meters);
  const existing = await meters.findOne({ _id: id as never });
  const d = mergeDerive(existing, id, p.msg, new Date());
  return { ok: true, id, status: d.status, summary: d.doc.s };
}
