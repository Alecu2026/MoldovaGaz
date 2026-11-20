/**
 * Contoare de TESTARE: N dispozitive (implicit 60.000), fiecare cu un mesaj în formatul ChirpStack + decoder Jooby, ca în exemplele reale
 * (aplicații pe orașe, gateway-uri cu coordonate, RSSI/SNR/DR corelate, CurrentTime / CurrentDataMul / HoursDataMul / LastEventSeq,
 * baterie slabă / offline / buton / magnet). Payload-urile trec prin parserul real de ingest (lib/uplink-parse.ts), deci tabelul și filtrele
 * le văd exact ca pe mesajele adevărate.
 *
 *   npm run seed:meters                 → 60.000 de contoare în colecția din UPLINKS_COLLECTION (implicit `uplinks`)
 *   npm run seed:meters -- 5000         → alt număr
 *   npm run seed:meters -- --dry        → doar generează și arată statistici + un exemplu (nu scrie nimic)
 *   npm run seed:meters -- --replace    → șterge întâi datele de test existente, apoi reinserează
 *   npm run seed:meters -- remove       → șterge DOAR documentele de test (cele cu câmpul testSeed)
 *
 * Documentele de test poartă `testSeed: "meters-60k"`; nimic altceva din colecție nu e atins. Generarea e deterministă (aceleași id-uri),
 * deci rularea repetată nu creează dubluri. După inserare repornește aplicația (pm2 restart) ca să-și reconstruiască lista din memorie.
 */
import { createHash } from "node:crypto";
import { connectMongo } from "../lib/mongo-core";
import { parseUplink } from "../lib/uplink-parse";

const TAG = "meters-60k";
type Gw = { id: string; name: string; lat: number; lon: number; alt: number };
type Town = { appId: string; app: string; weight: number; gws: Gw[] };

const gwId = (name: string) => createHash("sha1").update(name).digest("hex").slice(0, 16);
const gw = (name: string, lat: number, lon: number, alt = 0, id = gwId(name)): Gw => ({ id, name, lat, lon, alt });

const TOWNS: Town[] = [
  {
    appId: "7", app: "App_Comrat_Gaz_ABP_jooby", weight: 40,
    gws: [
      gw("M4_Comrat_Gaz", 46.29972715545776, 28.655695065390322, 0, "3135323512004d00"),
      gw("M-804750_Comrat_Novaia", 46.304808236423405, 28.635413646698, 0, "503139537f804750"),
      gw("RAK_60FD_Reserve", 46.29218, 28.67596, 171, "ac1f09fffe1060fd"),
      gw("M2_Comrat_Centru", 46.3012, 28.6561, 0),
    ],
  },
  { appId: "8", app: "App_CeadirLunga_Gaz_ABP_jooby", weight: 20, gws: [gw("M1_CeadirLunga_Gaz", 46.0551, 28.8262), gw("M-71C2E0_CeadirLunga_Sud", 46.0447, 28.8319, 12), gw("RAK_A3C1_CeadirLunga", 46.0612, 28.8105, 96)] },
  { appId: "9", app: "App_Vulcanesti_Gaz_ABP_jooby", weight: 15, gws: [gw("M3_Vulcanesti_Gaz", 45.6836, 28.4046), gw("M-5B10F4_Vulcanesti_Gara", 45.6741, 28.4198, 8), gw("RAK_C0DE_Vulcanesti", 45.6902, 28.3917, 41)] },
  { appId: "10", app: "App_Taraclia_Gaz_ABP_jooby", weight: 15, gws: [gw("M5_Taraclia_Gaz", 45.8986, 28.6692), gw("M-9A44C1_Taraclia_Centru", 45.9034, 28.6611, 20), gw("RAK_77B2_Taraclia", 45.8921, 28.6803, 55)] },
  { appId: "11", app: "App_Cimislia_Gaz_ABP_jooby", weight: 10, gws: [gw("M6_Cimislia_Gaz", 46.5257, 28.7743), gw("M-2E8D73_Cimislia_Nord", 46.5342, 28.7651, 30), gw("RAK_19F0_Cimislia", 46.5176, 28.7902, 64)] },
];
const FREQS = [868100000, 868300000, 868500000];
const PROFILE = { name: "Jooby_profile_2_device_ABP", id: "066bc2af-408a-462a-b55e-e198d3f84a73" };

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoSec = (ms: number) => iso(ms).replace(/\.\d{3}Z$/, "Z");
const isoMicro = (ms: number, rnd: () => number) => iso(ms).replace("Z", String(Math.floor(rnd() * 1000)).padStart(3, "0") + "Z");
const round1 = (x: number) => Math.round(x * 10) / 10;

function makePayload(i: number, now: number, rnd: () => number): Record<string, unknown> {
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const uuid = () => {
    const h = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16)).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${pick(["8", "9", "a", "b"])}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  // oraș (după pondere), model / serie / an, identificatori
  let r = rnd() * 100, town = TOWNS[0];
  for (const t of TOWNS) { if ((r -= t.weight) < 0) { town = t; break; } }
  const model = rnd() < 0.8 ? "2154" : rnd() < 0.75 ? "2155" : "2156";
  const serial = String(70000 + i * 3 + Math.floor(rnd() * 3)).padStart(8, "0");
  const year = 2021 + Math.floor(rnd() * 5);
  const devEUI = "001a7988" + (0x16000000 + i * 37 + Math.floor(rnd() * 30)).toString(16).padStart(8, "0");

  // moment: majoritatea au raportat în ultimele 24 h; ~8% sunt „tăcute” de 1–10 zile
  const silent = rnd() < 0.08;
  const ts = now - (silent ? (1 + rnd() * 9) * 86_400_000 : rnd() * 26 * 3_600_000);

  // semnal: gateway principal + 0–2 secundare mai slabe; SNR corelat cu RSSI (ca în exemple: -104→-2, -116→-11.5)
  const order = town.gws.map((g) => ({ g, k: rnd() })).sort((a, b) => a.k - b.k).map((x) => x.g);
  const nGw = rnd() < 0.55 ? 1 : rnd() < 0.7 ? 2 : 3;
  const base = Math.max(-123, Math.min(-72, -100 + (rnd() + rnd() + rnd() - 1.5) * 22));
  const rx = order.slice(0, nGw).map((g, k) => {
    const rssi = Math.max(-124, Math.round(base - (k === 0 ? 0 : 3 + rnd() * 12)));
    const snr = Math.max(-19, Math.min(11, round1(-2 + 0.8 * (rssi + 104) + (rnd() - 0.5) * 4)));
    const o: Record<string, unknown> = { gatewayID: g.id, uplinkID: uuid(), name: g.name };
    if (rnd() < 0.7) o.time = isoMicro(ts + k * -12 + Math.floor(rnd() * 20), rnd);
    o.rssi = rssi;
    o.loRaSNR = snr;
    o.location = { latitude: g.lat, longitude: g.lon, altitude: g.alt };
    return o;
  });
  const bestSnr = Math.max(...rx.map((x) => x.loRaSNR as number));
  const dr = bestSnr > -4 ? (rnd() < 0.7 ? 5 : 4) : bestSnr > -8 ? pick([3, 4]) : bestSnr > -12 ? pick([1, 2]) : pick([0, 1]);

  // ceasul intern al contorului e adesea dereglat (ca în exemple: 2002 / 2004)
  const clock = Date.UTC(2001 + Math.floor(rnd() * 5), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
  const reading = Math.floor(100 + rnd() * rnd() * 90_000); // citire cumulată (m³ × 1000 / impulsuri)
  const offline = silent ? rnd() < 0.5 : rnd() < 0.05;
  const status = { batteryTooLowVoltage: rnd() < 0.02, buttonPressed: rnd() < 0.005, magnet: rnd() < 0.01, offline };

  const kind = rnd();
  const els: Record<string, unknown>[] = [];
  const bytes: number[] = [];
  const rb = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 256));
  const push = (cmd: number, len: number) => bytes.push(cmd, len, ...rb(len));
  if (kind < 0.35) {
    els.push({ cmd: 9, corrSeq: 0, ieType: "CurrentTime", time: isoSec(clock) });
    els.push({ cmd: 24, ieType: "CurrentDataMul", values: [{ channel: 0, value: reading }] });
    push(9, 5); push(24, 7);
  } else if (kind < 0.7) {
    let v = reading;
    const values = Array.from({ length: 8 }, (_, h) => {
      v += rnd() < 0.45 ? 0 : Math.floor(rnd() * 3);
      return { channel: 0, time: isoSec(Math.floor(clock / 3_600_000) * 3_600_000 + h * 3_600_000), value: v };
    });
    els.push({ cmd: 23, ieType: "HoursDataMul", values });
    els.push({ cmd: 96, eventSeq: 1 + Math.floor(rnd() * 400), ieType: "LastEventSeq", status });
    push(23, 13); push(96, 4);
  } else if (kind < 0.85) {
    els.push({ cmd: 96, eventSeq: 1 + Math.floor(rnd() * 400), ieType: "LastEventSeq", status });
    push(96, 4);
  } else {
    els.push({ cmd: 24, ieType: "CurrentDataMul", values: [{ channel: 0, value: reading }] });
    els.push({ cmd: 96, eventSeq: 1 + Math.floor(rnd() * 400), ieType: "LastEventSeq", status });
    push(24, 7); push(96, 4);
  }
  const buf = Buffer.from(bytes);
  const lastRx = Math.max(...rx.map((x) => (x.time ? Date.parse(x.time as string) : ts)));

  return {
    applicationID: town.appId,
    applicationName: town.app,
    deviceName: `${model}_${serial}_${year}`,
    deviceProfileName: PROFILE.name,
    deviceProfileID: PROFILE.id,
    devEUI,
    rxInfo: rx,
    txInfo: { frequency: pick(FREQS), dr },
    adr: rnd() < 0.65,
    fCnt: Math.floor(Math.pow(rnd(), 0.7) * 45_000),
    fPort: 1,
    data: buf.toString("base64"),
    object: { decodeTime: iso(Math.max(lastRx, ts) + 150 + Math.floor(rnd() * 250)), decoded: els, hex: buf.toString("hex").toUpperCase(), version: "1.0.1" },
  };
}

async function main() {
  process.loadEnvFile(".env.local");
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const replace = args.includes("--replace");
  const remove = args.includes("remove");
  const n = Math.max(1, Number(args.find((a) => /^\d+$/.test(a))) || 60_000);
  const collName = process.env.UPLINKS_COLLECTION || "uplinks";

  if (dry) {
    const rnd = mulberry32(20261120);
    const now = Date.now();
    const stat = { apps: new Map<string, number>(), gws: new Map<string, number>(), types: new Map<string, number>(), batt: 0, off: 0, devs: new Set<string>() };
    let sample: unknown = null;
    for (let i = 0; i < n; i++) {
      const p = makePayload(i, now, rnd);
      const u = parseUplink(p, new Date(now));
      if ("error" in u) throw new Error(`mesaj ${i}: ${u.error}`);
      stat.devs.add(u.devEUI);
      stat.apps.set(u.s.a, (stat.apps.get(u.s.a) ?? 0) + 1);
      if (u.s.g) stat.gws.set(u.s.g, (stat.gws.get(u.s.g) ?? 0) + 1);
      for (const t of u.s.ty) stat.types.set(t, (stat.types.get(t) ?? 0) + 1);
      if (u.s.fl & 2) stat.batt++;
      if (u.s.fl & 16) stat.off++;
      if (i === 1) sample = p;
    }
    console.log(`${n} mesaje, ${stat.devs.size} devEUI distincte`);
    console.log("aplicații:", Object.fromEntries(stat.apps));
    console.log("tipuri:", Object.fromEntries(stat.types));
    console.log(`gateway-uri: ${stat.gws.size} · baterie slabă: ${stat.batt} · offline: ${stat.off}`);
    console.log("exemplu:\n" + JSON.stringify(sample));
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește din .env.local");
  const client = await connectMongo(url);
  try {
    const coll = client.db().collection(collName);
    if (remove || replace) {
      const r = await coll.deleteMany({ testSeed: TAG });
      console.log(`Șterse ${r.deletedCount} documente de test din ${collName}.`);
      if (remove) return;
    } else if ((await coll.countDocuments({ testSeed: TAG }, { limit: 1 })) > 0) {
      console.log(`În ${collName} există deja date de test (${TAG}). Folosește --replace ca să le refaci sau remove ca să le ștergi.`);
      return;
    }
    const rnd = mulberry32(20261120);
    const now = Date.now();
    console.log(`Generez ${n} contoare în ${client.db().databaseName}.${collName}…`);
    let inserted = 0, dup = 0;
    for (let off = 0; off < n; off += 5000) {
      const docs = [];
      for (let i = off; i < Math.min(n, off + 5000); i++) {
        const payload = makePayload(i, now, rnd);
        const u = parseUplink(payload, new Date(now)); // receivedAt provizoriu: îl aliniem mai jos la ts + latență
        if ("error" in u) throw new Error(`mesaj ${i}: ${u.error}`);
        docs.push({ ...u, receivedAt: new Date(u.s.t + 200 + Math.floor(rnd() * 500)), testSeed: TAG });
      }
      try {
        const res = await coll.insertMany(docs as never[], { ordered: false });
        inserted += res.insertedCount;
      } catch (e) {
        const err = e as { name?: string; insertedCount?: number; writeErrors?: unknown[] };
        if (err.name !== "MongoBulkWriteError") throw e;
        inserted += err.insertedCount ?? 0;
        dup += err.writeErrors?.length ?? 0;
      }
      process.stdout.write(`\r${Math.min(n, off + 5000)} / ${n}`);
    }
    console.log(`\nGata: ${inserted} inserate, ${dup} dubluri ignorate. Repornește aplicația (pm2 restart) ca să reconstruiască lista.`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
