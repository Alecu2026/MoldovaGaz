import "server-only";
import type { Document } from "mongodb";
import type { IntegrationMsg } from "../integration";
import { distanceKm } from "../geo";
import { buildStats, dayOf, foldDays, type DayAgg, type Hit, type Stats, type StatQuery } from "../gateway-stats";
import { col } from "../mongo";
import { getStore } from "./meter-dataset";

/**
 * ANTENE (gateway-uri LoRaWAN) — ce antene ne-au trimis mesaje și ce contoare aude fiecare, din `rxInfo`-ul uplink-urilor primite prin integrare.
 *
 *  - `integration_gateways`: { _id: id antenă, name, la, lo (poziție validă în Moldova, altfel lipsesc), n: mesaje, first, last, rc: ultimele 20 de cereri }
 *  - `integration_gw_dev`: o pereche antenă × contor: { _id: "antenă|contor", g, m, n, nr, rs: suma RSSI, ss: suma SNR, last, rl, sl: ultimul RSSI / SNR }
 * Ora folosită peste tot este ora mesajului din rețea (`decodeTime`), nu ceasul antenei (unele antene au ceasul greșit cu zile).
 * Scrierea se face din procesul care golește cutia de intrare, ÎNAINTE ca mesajele să se șteargă; o eroare aici nu blochează aplicarea mesajelor.
 */
export const GATEWAYS = process.env.INTEGRATION_GATEWAYS_COLLECTION || "integration_gateways";
export const GW_DEV = process.env.INTEGRATION_GW_DEV_COLLECTION || "integration_gw_dev";
/** agregate pe (antenă, zi UTC): mesaje, sume RSSI / SNR, contoare-zile; ținute 400 de zile */
export const GW_DAY = process.env.INTEGRATION_GW_DAY_COLLECTION || "integration_gw_day";
const RECENT = 20;
const ONLINE_MS = 3_600_000; // activă: a auzit ceva în ultima oră
const SLOW_MS = 24 * 3_600_000; // lentă: în ultimele 24 h; mai mult = offline

export type Recent = { m: string; t: number; rssi: number | null; snr: number | null; p: number | null; ie: string | null };
type InDoc = { id: string; at: number; m: IntegrationMsg };

let indexed = false;
async function ensureIndexes(): Promise<void> {
  if (indexed) return;
  const dev = await col<Document>(GW_DEV);
  const day = await col<Document>(GW_DAY);
  await Promise.all([dev.createIndex({ g: 1 }), dev.createIndex({ m: 1 }), dev.createIndex({ last: 1 }), day.createIndex({ d: 1 }), day.createIndex({ createdAt: 1 }, { expireAfterSeconds: 400 * 86_400 })]);
  indexed = true;
}

/** Apelat de procesul care golește cutia: un lot de mesaje → o scriere în bloc pe antene și una pe perechile antenă × contor. */
export async function recordGateways(docs: InDoc[], now: number): Promise<void> {
  type G = { name: string; la: number | null; lo: number | null; n: number; last: number; first: number; recent: Recent[] };
  type P = { g: string; m: string; n: number; nr: number; rs: number; ss: number; ns: number; last: number; rl: number | null; sl: number | null };
  const gws = new Map<string, G>(), pairs = new Map<string, P>();
  const hitsAll: Hit[] = [];
  for (const d of docs) {
    const hits = d.m.gws;
    if (!hits?.length) continue;
    const t = Math.min(now, d.m.pulse?.t ?? Math.max(0, ...Object.values(d.m.tel).map((x) => x.t)) ?? d.at) || d.at;
    const ie = d.m.tel.ieType?.v ?? null;
    for (const h of hits) {
      let g = gws.get(h.id);
      if (!g) gws.set(h.id, (g = { name: h.name, la: h.la, lo: h.lo, n: 0, last: 0, first: t, recent: [] }));
      g.n++;
      g.last = Math.max(g.last, t);
      g.first = Math.min(g.first, t);
      if (h.la !== null) { g.la = h.la; g.lo = h.lo; }
      g.recent.push({ m: d.id, t, rssi: h.rssi, snr: h.snr, p: d.m.pulse?.v ?? null, ie });
      hitsAll.push({ g: h.id, m: d.id, t, rssi: h.rssi, snr: h.snr });
      const k = `${h.id}|${d.id}`;
      let p = pairs.get(k);
      if (!p) pairs.set(k, (p = { g: h.id, m: d.id, n: 0, nr: 0, rs: 0, ss: 0, ns: 0, last: 0, rl: null, sl: null }));
      p.n++;
      if (h.rssi !== null) { p.nr++; p.rs += h.rssi; }
      if (h.snr !== null) { p.ns++; p.ss += h.snr; }
      if (t >= p.last) { p.last = t; p.rl = h.rssi; p.sl = h.snr; }
    }
  }
  if (!gws.size) return;
  await ensureIndexes();
  // zilele deja numărate pentru fiecare pereche (ca un contor să se numere o singură dată pe zi la o antenă)
  const pairKeys = [...pairs.keys()];
  const ldMap = new Map<string, number>();
  const devColl = await col<Document>(GW_DEV);
  for (let i = 0; i < pairKeys.length; i += 1000) {
    for (const x of await devColl.find({ _id: { $in: pairKeys.slice(i, i + 1000) } as never }, { projection: { ld: 1 } }).toArray()) if (typeof x.ld === "number") ldMap.set(String(x._id), x.ld);
  }
  const { days, pairLd } = foldDays(hitsAll, ldMap);
  await (await col<Document>(GW_DAY)).bulkWrite(
    [...days].map(([k, a]) => ({ updateOne: { filter: { _id: k as never }, update: { $inc: { n: a.n, nr: a.nr, rs: a.rs, ns: a.ns, ss: a.ss, dv: a.dv }, $set: { g: a.g, d: a.d }, $setOnInsert: { createdAt: new Date(now) } }, upsert: true } })) as never,
    { ordered: false },
  );
  await (await col<Document>(GATEWAYS)).bulkWrite(
    [...gws].map(([id, g]) => {
      g.recent.sort((a, b) => a.t - b.t);
      const set: Document = { name: g.name };
      if (g.la !== null) { set.la = g.la; set.lo = g.lo; }
      return { updateOne: { filter: { _id: id as never }, update: { $inc: { n: g.n }, $max: { last: g.last }, $min: { first: g.first }, $set: set, $push: { rc: { $each: g.recent.slice(-RECENT), $slice: -RECENT } } }, upsert: true } };
    }) as never,
    { ordered: false },
  );
  await (await col<Document>(GW_DEV)).bulkWrite(
    [...pairs].map(([k, p]) => ({
      updateOne: {
        filter: { _id: k as never },
        update: { $inc: { n: p.n, nr: p.nr, rs: p.rs, ss: p.ss, ns: p.ns }, $max: { last: p.last, ...(pairLd.has(k) ? { ld: pairLd.get(k) } : {}) }, $set: { g: p.g, m: p.m, ...(p.rl !== null ? { rl: p.rl } : {}), ...(p.sl !== null ? { sl: p.sl } : {}) } },
        upsert: true,
      },
    })) as never,
    { ordered: false },
  );
}

/* ───────── citire ───────── */
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export type GwState = "on" | "slow" | "off";
export type GwRow = { id: string; name: string; la: number | null; lo: number | null; n: number; last: number; state: GwState; devices: number; primary: number; exclusive: number; rssi: number | null; snr: number | null };
export type GwSummary = { total: number; located: number; on: number; slow: number; off: number; rows: GwRow[]; at: number };

const stateOf = (last: number, now: number): GwState => (now - last < ONLINE_MS ? "on" : now - last < SLOW_MS ? "slow" : "off");

type Pair = { g: string; m: string; n: number; nr: number; rs: number; ns: number; ss: number; last: number; rl?: number; sl?: number };
const g0 = globalThis as unknown as { __gwSum?: { at: number; v: GwSummary }; __gwIdx?: { gen: string; n: number; map: Map<string, number> } };

async function meterIndex() {
  const store = await getStore();
  if (!g0.__gwIdx || g0.__gwIdx.gen !== store.gen || g0.__gwIdx.n !== store.cols.id.length) {
    const map = new Map<string, number>();
    store.cols.id.forEach((id, i) => map.set(id, i));
    g0.__gwIdx = { gen: store.gen, n: store.cols.id.length, map };
  }
  return { c: store.cols, map: g0.__gwIdx.map };
}

/** Lista antenelor cu eficiența fiecăreia. Se reține 15 s (un singur calcul pentru toți utilizatorii). */
export async function gatewaySummary(): Promise<GwSummary> {
  const now = Date.now();
  if (g0.__gwSum && now - g0.__gwSum.at < 15_000) return g0.__gwSum.v;
  const [gdocs, pdocs] = await Promise.all([
    (await col<Document>(GATEWAYS)).find({}, { projection: { rc: 0 } }).toArray(),
    (await col<Pair>(GW_DEV)).find({}, { projection: { g: 1, m: 1, n: 1, nr: 1, rs: 1, ns: 1, ss: 1 } }).toArray() as Promise<Pair[]>,
  ]);
  // pentru fiecare contor: antena cu cel mai bun semnal mediu și câte antene îl aud
  const best = new Map<string, { g: string; r: number; k: number }>();
  const heard = new Map<string, number>();
  for (const p of pdocs) {
    heard.set(p.m, (heard.get(p.m) ?? 0) + 1);
    const r = p.nr > 0 ? p.rs / p.nr : -999;
    const b = best.get(p.m);
    if (!b || r > b.r) best.set(p.m, { g: p.g, r, k: 0 });
  }
  const acc = new Map<string, { devices: number; primary: number; exclusive: number; rs: number; nr: number; ss: number; ns: number }>();
  for (const p of pdocs) {
    let a = acc.get(p.g);
    if (!a) acc.set(p.g, (a = { devices: 0, primary: 0, exclusive: 0, rs: 0, nr: 0, ss: 0, ns: 0 }));
    a.devices++;
    if (best.get(p.m)?.g === p.g) a.primary++;
    if (heard.get(p.m) === 1) a.exclusive++;
    a.rs += p.rs ?? 0; a.nr += p.nr ?? 0; a.ss += p.ss ?? 0; a.ns += p.ns ?? 0;
  }
  const rows: GwRow[] = gdocs.map((d) => {
    const a = acc.get(String(d._id));
    const last = Number(d.last) || 0;
    return {
      id: String(d._id), name: String(d.name ?? d._id), la: typeof d.la === "number" ? d.la : null, lo: typeof d.lo === "number" ? d.lo : null,
      n: Number(d.n) || 0, last, state: stateOf(last, now), devices: a?.devices ?? 0, primary: a?.primary ?? 0, exclusive: a?.exclusive ?? 0,
      rssi: a && a.nr ? r1(a.rs / a.nr) : null, snr: a && a.ns ? r1(a.ss / a.ns) : null,
    };
  });
  rows.sort((a, b) => b.devices - a.devices);
  const v: GwSummary = { total: rows.length, located: rows.filter((r) => r.la !== null).length, on: rows.filter((r) => r.state === "on").length, slow: rows.filter((r) => r.state === "slow").length, off: rows.filter((r) => r.state === "off").length, rows, at: now };
  g0.__gwSum = { at: now, v };
  return v;
}

const statCache = new Map<string, { at: number; v: Stats }>();
/** Eficiența antenelor pe o perioadă (pe zile): vezi lib/gateway-stats.ts. Contoarele auzite = perechile antenă × contor cu ultimul moment în perioadă. Reținut 15 s. */
export async function gatewayStats(q: StatQuery): Promise<Stats> {
  const key = JSON.stringify(q);
  const hit = statCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.v;
  const sum = await gatewaySummary();
  const [dayDocs, inRows] = await Promise.all([
    (await col<Document>(GW_DAY)).find({ d: { $gte: dayOf(Math.min(q.from, q.to)), $lte: dayOf(Math.max(q.from, q.to)) } }).toArray(),
    (await col<Document>(GW_DEV)).aggregate([{ $match: { last: { $gte: q.from } } }, { $group: { _id: "$g", n: { $sum: 1 } } }]).toArray(),
  ]);
  const devicesIn = new Map<string, number>(inRows.map((x) => [String(x._id), Number(x.n) || 0]));
  const v = buildStats(sum.rows, dayDocs as unknown as DayAgg[], devicesIn, q);
  statCache.set(key, { at: Date.now(), v });
  if (statCache.size > 40) statCache.delete(statCache.keys().next().value as string);
  return v;
}

export type GwDevice = { id: string; name: string; branch: string | null; la: number | null; lo: number | null; km: number | null; rssi: number | null; snr: number | null; n: number; last: number; ts: number; volume: number | null };
export type GwDetail = {
  gateway: GwRow; devicesTotal: number; recent: (Recent & { name: string })[];
  nearest: GwDevice | null; farthest: GwDevice | null; strongest: GwDevice | null; weakest: GwDevice | null;
  /** contoarele cu coordonate, cele mai apropiate primele (pentru liniile de pe hartă) */
  devices: GwDevice[];
  /** TOATE contoarele auzite de antenă (și cele fără coordonate), cele mai recente întâi, cel mult 3000 (pentru popup-ul din Grafice) */
  list: GwDevice[];
};

export async function gatewayDetail(id: string): Promise<GwDetail | null> {
  const [sum, gdoc, pairs, idx] = await Promise.all([
    gatewaySummary(),
    (await col<Document>(GATEWAYS)).findOne({ _id: id as never }),
    (await col<Pair>(GW_DEV)).find({ g: id } as never).toArray() as Promise<Pair[]>,
    meterIndex(),
  ]);
  const row = sum.rows.find((r) => r.id === id);
  if (!gdoc || !row) return null;
  const { c, map } = idx;
  const devices: GwDevice[] = pairs.map((p) => {
    const i = map.get(p.m);
    // coordonate lipsă în listă = NaN: se tratează ca «fără poziție» (altfel contorul ar intra în clasament cu distanță NaN și n-ar avea linie pe hartă)
    const la = i !== undefined && Number.isFinite(c.la[i]) ? c.la[i] : null, lo = i !== undefined && Number.isFinite(c.lo[i]) ? c.lo[i] : null;
    const kmv = row.la !== null && row.lo !== null && la !== null && lo !== null ? r2(distanceKm(row.la, row.lo, la, lo)) : null;
    return {
      id: p.m, name: i !== undefined ? c.nm[i] : p.m, branch: null, la, lo, km: kmv,
      rssi: p.nr ? r1(p.rs / p.nr) : typeof p.rl === "number" ? p.rl : null, snr: p.ns ? r1(p.ss / p.ns) : null,
      n: p.n, last: p.last, ts: i !== undefined ? c.ts[i] : 0, volume: i !== undefined ? c.val[i] : null,
    };
  });
  const withKm = devices.filter((d) => d.km !== null);
  const byKm = [...withKm].sort((a, b) => (a.km as number) - (b.km as number));
  const withRssi = devices.filter((d) => d.rssi !== null).sort((a, b) => (b.rssi as number) - (a.rssi as number));
  const names = new Map(devices.map((d) => [d.id, d.name]));
  const recent = ((gdoc.rc as Recent[] | undefined) ?? []).slice().reverse().map((x) => ({ ...x, name: names.get(x.m) ?? x.m }));
  return {
    gateway: row, devicesTotal: devices.length, recent,
    nearest: byKm[0] ?? null, farthest: byKm.length ? byKm[byKm.length - 1] : null,
    strongest: withRssi[0] ?? null, weakest: withRssi.length ? withRssi[withRssi.length - 1] : null,
    // liniile spre contoare: toate cele cu poziție (cel mult 3000, cele mai apropiate); la 800 antenele cu multe contoare pierdeau liniile spre cele mai îndepărtate
    devices: byKm.slice(0, 3000),
    list: [...devices].sort((a, b) => b.last - a.last).slice(0, 3000),
  };
}

export type DevGateway = { id: string; name: string; la: number | null; lo: number | null; km: number | null; rssi: number | null; snr: number | null; n: number; last: number; state: GwState; primary: boolean };

/** Antenele care aud un contor, cu cea mai bună marcată „principală”. */
export async function deviceGateways(meterId: string): Promise<DevGateway[]> {
  const [sum, pairs, idx] = await Promise.all([gatewaySummary(), (await col<Pair>(GW_DEV)).find({ m: meterId } as never).toArray() as Promise<Pair[]>, meterIndex()]);
  const i = idx.map.get(meterId);
  const mla = i !== undefined ? idx.c.la[i] : null, mlo = i !== undefined ? idx.c.lo[i] : null;
  const by = new Map(sum.rows.map((r) => [r.id, r]));
  const out: DevGateway[] = pairs.map((p) => {
    const g = by.get(p.g);
    const kmv = g && g.la !== null && g.lo !== null && mla !== null && mlo !== null ? r2(distanceKm(g.la, g.lo, mla, mlo)) : null;
    return { id: p.g, name: g?.name ?? p.g, la: g?.la ?? null, lo: g?.lo ?? null, km: kmv, rssi: p.nr ? r1(p.rs / p.nr) : null, snr: p.ns ? r1(p.ss / p.ns) : null, n: p.n, last: p.last, state: g?.state ?? "off", primary: false };
  });
  out.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999) || b.n - a.n);
  if (out.length) out[0].primary = true;
  return out;
}
