import "server-only";
import type { Document, ObjectId } from "mongodb";
import { appendReadingsFor } from "../meter-readings";
import { mergeDerive, mergeMsgs, parseMessage, type IntegrationMsg, type MeterDocIng } from "../integration";
import { nameKey } from "../integration-uplink";
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
/** tot ce nu se potrivește cu formatul de contor (sau contorul nu se cunoaște), păstrat pentru procesare ulterioară */
export const RAW = process.env.INTEGRATION_RAW_COLLECTION || "integration_raw";
const RAW_MAX_CHARS = 256 * 1024;
/** evidența contoarelor care au trimis date prin integrare: { _id: contor, n: câte mesaje, last: ultimul moment, name } */
export const SEEN = process.env.INTEGRATION_SEEN_COLLECTION || "integration_seen";
const MAX_INBOX = Number(process.env.INTEGRATION_MAX_INBOX) > 0 ? Number(process.env.INTEGRATION_MAX_INBOX) : 500_000;
const BATCH = 1000;
const IDLE_MS = 250;

type InboxDoc = { _id: ObjectId; id: string; at: number; m: IntegrationMsg };
type Ev = { at: number; id: string; name: string; status: string };
type State = {
  started: boolean; running: boolean; timer: ReturnType<typeof setTimeout> | null; failDelay: number; lastError: string | null;
  received: number; rejected: number; kept: number; processed: number; created: number; updated: number; unchanged: number; dead: number; busy: number;
  sec: Map<number, { rx: number; ok: number }>; events: Ev[]; lastBatch: { n: number; ms: number; at: number } | null; batchMs: number[];
  depth: { at: number; n: number }; maps: { gen: string; n: number; names: Map<string, string>; euis: Map<string, string>; keys: Map<string, string | null> } | null; indexed: boolean;
};
const g = globalThis as unknown as { __integ?: State };
function st(): State {
  return (g.__integ ??= {
    started: false, running: false, timer: null, failDelay: 0, lastError: null,
    received: 0, rejected: 0, kept: 0, processed: 0, created: 0, updated: 0, unchanged: 0, dead: 0, busy: 0,
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
type Resolver = { byName: (n: string) => string | null; byEui: (e: string) => string | null; byKey: (k: string) => string | null };
async function resolver(): Promise<Resolver> {
  const s = st();
  const store = await getStore();
  if (!s.maps || s.maps.gen !== store.gen || s.maps.n !== store.cols.id.length) {
    const names = new Map<string, string>(), euis = new Map<string, string>(), keys = new Map<string, string | null>();
    const c = store.cols;
    for (let i = 0; i < c.id.length; i++) {
      if (c.nm[i]) names.set(c.nm[i], c.id[i]);
      if (c.eu[i]) euis.set(c.eu[i], c.id[i]);
      const k = nameKey(c.nm[i]);
      if (k) keys.set(k, keys.has(k) ? null : c.id[i]); // același model_serie_an la mai multe dispozitive ⇒ ambiguu, nu se folosește
    }
    s.maps = { gen: store.gen, n: c.id.length, names, euis, keys };
  }
  const m = s.maps;
  return { byName: (n) => m.names.get(n) ?? null, byEui: (e) => m.euis.get(e) ?? null, byKey: (k) => m.keys.get(k) ?? null };
}

/** Contorul unui mesaj: id (UUID) → devEUI (cel mai sigur) → nume exact → „model_serie_an”. null = necunoscut. */
const resolveId = (msg: IntegrationMsg, r: Resolver | null): string | null =>
  msg.id ?? (r ? (msg.eui && r.byEui(msg.eui)) || (msg.name && r.byName(msg.name)) || (msg.nameKey && r.byKey(msg.nameKey)) || null : null);

export type AcceptResult = { received: number; accepted: number; kept: number; reasons?: string[] };
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

/** Un element păstrat pentru procesare ulterioară: conținutul original (tăiat dacă e foarte mare) și motivul. */
function keptDoc(raw: unknown, reason: string, at: number): { at: number; reason: string; raw: unknown; truncated?: true } {
  let body: unknown = raw;
  let truncated = false;
  try {
    const t = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (t !== undefined && t.length > RAW_MAX_CHARS) { body = t.slice(0, RAW_MAX_CHARS); truncated = true; }
  } catch {
    body = String(raw).slice(0, RAW_MAX_CHARS);
    truncated = true;
  }
  return { at, reason, raw: body, ...(truncated ? { truncated: true as const } : {}) };
}

/**
 * Salvează DURABIL tot ce a primit. Mesajele valide merg în cutia de intrare (se aplică pe contoare); orice altceva (alt format, contor necunoscut, text) se păstrează
 * în `integration_raw`, cu motivul, pentru procesare ulterioară — nu se refuză. Aruncă (⇒ fără răspuns de succes) doar dacă salvarea eșuează sau cutia e plină.
 */
export async function accept(items: unknown[]): Promise<AcceptResult> {
  const s = st();
  const now = Date.now();
  const b = bucket(s, now);
  s.received += items.length;
  b.rx += items.length;
  const kept: { at: number; reason: string; raw: unknown; truncated?: true }[] = [];
  const parsed: { msg: IntegrationMsg; raw: unknown }[] = [];
  for (const it of items) {
    const p = parseMessage(it, now);
    if (p.ok) parsed.push({ msg: p.msg, raw: it });
    else kept.push(keptDoc(it, p.error, now));
  }
  const docs: { id: string; at: number; m: IntegrationMsg }[] = [];
  if (parsed.length) {
    const r = parsed.some((x) => !x.msg.id) ? await resolver() : null;
    for (const { msg, raw } of parsed) {
      const id = resolveId(msg, r);
      if (!id) kept.push(keptDoc(raw, "contor necunoscut (nu există în aplicație după id, nume sau devEUI)", now));
      else docs.push({ id, at: now, m: { ...msg, id } });
    }
  }
  if (docs.length || kept.length) {
    if (docs.length && (await depth()) + docs.length > MAX_INBOX) {
      s.busy++;
      throw new BusyError(Math.min(30, 2 + Math.floor((await depth()) / 20_000)));
    }
    const wc = { w: 1 as const, j: true };
    if (docs.length) {
      const inbox = await col<Document>(INBOX);
      for (let i = 0; i < docs.length; i += 1000) await inbox.insertMany(docs.slice(i, i + 1000) as never, { ordered: false, writeConcern: wc });
      s.depth.n += docs.length;
    }
    if (kept.length) {
      const raw = await col<Document>(RAW);
      for (let i = 0; i < kept.length; i += 1000) await raw.insertMany(kept.slice(i, i + 1000).map((k) => ({ ...k, createdAt: new Date(now) })) as never, { ordered: false, writeConcern: wc });
      s.kept += kept.length;
    }
    if (docs.length) kick();
  }
  s.rejected += kept.length;
  b.ok += docs.length;
  for (const d of docs.slice(0, 20)) pushEv(s, { at: now, id: d.id, name: d.m.name ?? "", status: "primit" });
  for (const k of kept.slice(0, 5)) pushEv(s, { at: now, id: "", name: k.reason.slice(0, 60), status: "păstrat" });
  const reasons = [...new Set(kept.map((k) => k.reason))].slice(0, 5);
  return { received: items.length, accepted: docs.length, kept: kept.length, ...(reasons.length ? { reasons } : {}) };
}

/**
 * Reia din `integration_raw` ce se poate aplica acum (de ex. după ce a apărut contorul sau am adaptat formatul): ce trece validarea merge în cutia de intrare și se
 * șterge din păstrare; restul rămâne cu motivul actualizat. Întoarce câte s-au mutat și câte au rămas.
 */
export async function reprocessKept(limit = 1000): Promise<{ moved: number; remaining: number }> {
  const raw = await col<Document>(RAW);
  const now = Date.now();
  const batch = await raw.find({}).sort({ _id: 1 }).limit(limit).toArray();
  const r = await resolver();
  const moveIds: unknown[] = [];
  const docs: { id: string; at: number; m: IntegrationMsg }[] = [];
  for (const k of batch) {
    const p = parseMessage(k.raw, now);
    if (!p.ok) continue;
    const id = resolveId(p.msg, r);
    if (!id) continue;
    docs.push({ id, at: now, m: { ...p.msg, id } });
    moveIds.push(k._id);
  }
  if (docs.length) {
    const inbox = await col<Document>(INBOX);
    for (let i = 0; i < docs.length; i += 1000) await inbox.insertMany(docs.slice(i, i + 1000) as never, { ordered: false, writeConcern: { w: 1, j: true } });
    await raw.deleteMany({ _id: { $in: moveIds } as never });
    st().depth.n += docs.length;
    kick();
  }
  return { moved: docs.length, remaining: await raw.estimatedDocumentCount() };
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
  // evidența contoarelor care trimit date (pentru pagina /integration): un $inc pe contor, într-o singură scriere în bloc
  const per = new Map<string, { n: number; last: number }>();
  for (const d of docs) {
    const e = per.get(d.id) ?? { n: 0, last: 0 };
    e.n++;
    e.last = Math.max(e.last, ...Object.values(d.m.tel).map((x) => x.t), d.m.pulse?.t ?? 0);
    per.set(d.id, e);
  }
  await (await col<Document>(SEEN)).bulkWrite(
    [...per].map(([id, e]) => ({ updateOne: { filter: { _id: id as never }, update: { $inc: { n: e.n }, $max: { last: e.last }, $set: { name: existing.get(id)?.tb.name ?? by.get(id)?.name ?? "", at: Date.now() } }, upsert: true } })) as never,
    { ordered: false },
  );
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
      await (await col<Document>(RAW)).createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });
      s.indexed = true;
    } catch (e) {
      console.error("[integration] indecși:", (e as Error).message);
    }
    kick();
    // datele păstrate (alt format / contor necunoscut) se reiau la pornire și apoi la fiecare 10 minute: contorul poate apărea între timp
    const retry = () => void reprocessKept(2000).catch((e) => console.error("[integration] reluarea datelor păstrate:", (e as Error).message));
    setTimeout(retry, 15_000).unref?.();
    setInterval(retry, 10 * 60_000).unref?.();
  })();
}

export type IntegrationStats = {
  enabled: boolean; startedWorker: boolean; depth: number; oldestAgeMs: number | null; lastError: string | null;
  totals: { received: number; kept: number; rejected: number; processed: number; created: number; updated: number; unchanged: number; dead: number; busy: number };
  perSecond: { rx: number[]; ok: number[] }; rateRx10: number; rateOk10: number;
  lastBatch: { n: number; ms: number; at: number } | null; batchP50: number | null; batchP95: number | null;
  events: Ev[]; maxInbox: number; deadCount: number; keptCount: number;
};
export async function integrationStats(): Promise<IntegrationStats> {
  const s = st();
  const inbox = await col<InboxDoc>(INBOX);
  const [n, oldest, deadCount, keptCount] = await Promise.all([inbox.estimatedDocumentCount(), inbox.find({}, { projection: { at: 1 } }).sort({ _id: 1 }).limit(1).next(), (await col<Document>(DEAD)).estimatedDocumentCount(), (await col<Document>(RAW)).estimatedDocumentCount()]);
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
    totals: { received: s.received, kept: s.kept, rejected: s.rejected, processed: s.processed, created: s.created, updated: s.updated, unchanged: s.unchanged, dead: s.dead, busy: s.busy },
    perSecond: { rx, ok }, rateRx10: Math.round((sum(rx.slice(-10)) / 10) * 10) / 10, rateOk10: Math.round((sum(ok.slice(-10)) / 10) * 10) / 10,
    lastBatch: s.lastBatch, batchP50: pct(0.5), batchP95: pct(0.95), events: s.events.slice(-40).reverse(), maxInbox: MAX_INBOX, deadCount, keptCount,
  };
}

export type SeenRow = { id: string; name: string; branch: string | null; n: number; last: number };
export type KeptRow = { key: string; deviceName: string; app: string; n: number; last: number; meter: string | null; branch: string | null };
export type IntegrationDevices = { seenTotal: number; seen: SeenRow[]; keptDevices: number; keptMatched: number; keptMessages: number; kept: KeptRow[] };

/** „De la care contoare ia date”: contoarele care au trimis prin integrare (cu număr de mesaje și ultimul moment) + ce s-a păstrat, grupat pe dispozitiv, cu contorul cu care se potrivește. */
export async function integrationDevices(limit = 200): Promise<IntegrationDevices> {
  const store = await getStore();
  const meterInfo = (id: string): { name: string; branch: string | null } | null => {
    const i = store.idx.get(id);
    return i === undefined ? null : { name: store.cols.nm[i], branch: store.cols.br[i] >= 0 ? store.dict.br[store.cols.br[i]] : null };
  };
  const seenColl = await col<Document>(SEEN);
  const [seenTotal, seenDocs] = await Promise.all([seenColl.estimatedDocumentCount(), seenColl.find({}).sort({ last: -1 }).limit(limit).toArray()]);
  const seen: SeenRow[] = seenDocs.map((d) => ({ id: String(d._id), name: meterInfo(String(d._id))?.name ?? d.name ?? "", branch: meterInfo(String(d._id))?.branch ?? null, n: d.n ?? 0, last: d.last ?? 0 }));

  const raw = await col<Document>(RAW);
  const groups = await raw.aggregate([
    { $match: { "raw.devEUI": { $exists: true } } },
    { $group: { _id: { $toLower: "$raw.devEUI" }, n: { $sum: 1 }, deviceName: { $first: "$raw.deviceName" }, app: { $first: "$raw.applicationName" }, last: { $max: "$at" } } },
    { $sort: { n: -1 } },
  ]).toArray();
  const r = await resolver();
  let keptMatched = 0, keptMessages = 0;
  const kept: KeptRow[] = [];
  for (const g of groups) {
    const id = r.byEui(String(g._id)) ?? (nameKey(g.deviceName) ? r.byKey(nameKey(g.deviceName) as string) : null);
    const info = id ? meterInfo(id) : null;
    if (info) keptMatched++;
    keptMessages += g.n;
    if (kept.length < limit) kept.push({ key: String(g._id), deviceName: String(g.deviceName ?? ""), app: String(g.app ?? ""), n: g.n, last: g.last ?? 0, meter: info?.name ?? null, branch: info?.branch ?? null });
  }
  return { seenTotal, seen, keptDevices: groups.length, keptMatched, keptMessages, kept };
}

/** Verificare fără scriere: validează mesajul și arată ce document ar rezulta (rezumatul derivat). */
export async function checkMessage(x: unknown): Promise<{ ok: true; id: string | null; status: string; summary: unknown } | { ok: false; error: string }> {
  const p = parseMessage(x);
  if (!p.ok) return p;
  const r = p.msg.id ? null : await resolver();
  const id = resolveId(p.msg, r);
  if (!id) return { ok: false, error: "contor necunoscut: trimite id (UUID) sau un nume / devEUI existent în aplicație" };
  const meters = await col<MeterDocIng>(COLLECTIONS.meters);
  const existing = await meters.findOne({ _id: id as never });
  const d = mergeDerive(existing, id, p.msg, new Date());
  return { ok: true, id, status: d.status, summary: d.doc.s };
}
