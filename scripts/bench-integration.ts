/**
 * Instrument de încărcare și verificare pentru API-ul de INTEGRARE (POST /api/integration). Trimite mesaje către UN server al nostru (nu către SCADA) și verifică
 * în baza de date că niciun mesaj CONFIRMAT (răspuns 200) nu s-a pierdut.
 *
 *   npm run bench:integration -- load   [--rate 20] [--seconds 20] [--batch 1]        ritm constant (ca antenele): latențe p50 / p95 / p99
 *   npm run bench:integration -- burst  [--total 3000] [--concurrency 200] [--batch 1]  vârf: multe cereri deodată; la 503 reîncearcă (Retry-After)
 *   npm run bench:integration -- verify                                                 verifică mesajele confirmate (din fișierul de stare) în baza de date
 *   npm run bench:integration -- auth                                                   verifică respingerea fără token / cu token greșit
 *
 * Mediu: INTEGRATION_URL (implicit http://localhost:3000), INTEGRATION_TOKEN, DATABASE_URL. Fișierul de stare: --state <fișier> (implicit bench-state.json).
 * Contoarele folosite sunt luate din colecția `meters` (primele --meters, implicit 3000): mesajele ajung pe contoare reale din baza indicată, deci rulează-l doar pe o
 * bază de TEST.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { connectMongo } from "../lib/mongo-core";

const argv = process.argv.slice(2);
const mode = argv[0];
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const num = (k: string, d: number) => Number(arg(k, String(d))) || d;
const URL_ = (process.env.INTEGRATION_URL || "http://localhost:3000").replace(/\/$/, "") + "/api/integration";
const TOKEN = process.env.INTEGRATION_TOKEN || "";
const STATE = arg("--state", "bench-state.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN);

type Acked = Record<string, { t: number; v: string }>;
const loadState = (): Acked => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as Acked) : {});
let acked: Acked = {};
const saveState = () => writeFileSync(STATE, JSON.stringify(acked));

async function pickMeters(n: number): Promise<{ id: string; name: string }[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const c = await connectMongo(url);
  try {
    const docs = await c.db().collection<{ _id: string; s: { n: string } }>(process.env.METERS_COLLECTION || "meters").find({}, { projection: { "s.n": 1 } }).sort({ _id: 1 }).limit(n).toArray();
    return docs.map((d) => ({ id: String(d._id), name: d.s.n }));
  } finally {
    await c.close();
  }
}

let seq = 0;
const mkMsg = (m: { id: string; name: string }) => {
  const t = Date.now() - 1000 + (seq % 900); // momente reale, crescătoare în timp
  seq++;
  const v = (1000 + seq).toString();
  return { msg: { id: m.id, tb: { name: m.name }, attrs: { active: true }, tel: { Volume_m3_Total: { t, v }, rssi: { t, v: "-100" }, temp: { t, v: "21" }, offline: { t, v: "false" }, ieType: { t, v: "LastEventSeq" } } }, t, v };
};

type Sent = { id: string; t: number; v: string }[];
async function post(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; ms: number; retryAfter: number; json: unknown }> {
  const t0 = performance.now();
  const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
  const ms = performance.now() - t0;
  let json: unknown = null;
  try { json = await r.json(); } catch { /* fără corp */ }
  return { status: r.status, ms, retryAfter: Number(r.headers.get("retry-after")) || 0, json };
}
const record = (sent: Sent) => { for (const s of sent) if (!acked[s.id] || s.t >= acked[s.id].t) acked[s.id] = { t: s.t, v: s.v }; };

async function sendOnce(meters: { id: string; name: string }[], batch: number, lat: number[], tally: Record<string, number>, retry: boolean): Promise<void> {
  const items = Array.from({ length: batch }, () => mkMsg(meters[Math.floor(Math.random() * meters.length)]));
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await post(batch === 1 ? items[0].msg : items.map((i) => i.msg));
    } catch {
      tally.netErr = (tally.netErr ?? 0) + 1; // serverul nu a răspuns: mesajul NU e confirmat
      if (!retry || attempt >= 30) return;
      await sleep(500);
      continue;
    }
    lat.push(res.ms);
    tally[String(res.status)] = (tally[String(res.status)] ?? 0) + 1;
    if (res.status === 200) {
      record(items.map((i) => ({ id: i.msg.id, t: i.t, v: i.v })));
      return;
    }
    if (!retry || (res.status !== 503 && res.status !== 429) || attempt >= 60) return;
    tally.retried = (tally.retried ?? 0) + 1;
    await sleep(Math.max(200, res.retryAfter * 1000));
  }
}

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  if (!TOKEN && mode !== "verify") throw new Error("INTEGRATION_TOKEN lipsește.");
  acked = loadState();

  if (mode === "auth") {
    const no = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const bad = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer gresit-gresit-gresit-gresit" }, body: "{}" });
    const badJson = await post("nu e json".repeat(1) as never, {}).catch(() => null);
    const invalid = await post({ ceva: 1 });
    const empty = await post([]);
    console.log(`fără token: ${no.status} (așteptat 401) · token greșit: ${bad.status} (401) · alt format: ${invalid.status} (200, păstrat) · listă goală: ${empty.status} (200) · text oarecare: ${badJson?.status} (200, păstrat)`);
    return;
  }

  if (mode === "load" || mode === "burst") {
    const meters = await pickMeters(num("--meters", 3000));
    if (meters.length === 0) throw new Error("nu există contoare în baza de date");
    const batch = num("--batch", 1);
    const lat: number[] = [];
    const tally: Record<string, number> = {};
    const t0 = Date.now();
    let sent = 0;
    if (mode === "load") {
      const rate = num("--rate", 20), seconds = num("--seconds", 20);
      const inflight: Promise<void>[] = [];
      const total = rate * seconds;
      for (let i = 0; i < total; i++) {
        const due = t0 + (i * 1000) / rate;
        const w = due - Date.now();
        if (w > 0) await sleep(w);
        sent++;
        inflight.push(sendOnce(meters, batch, lat, tally, true));
      }
      await Promise.all(inflight);
    } else {
      const total = num("--total", 3000), conc = num("--concurrency", 200);
      let next = 0;
      await Promise.all(Array.from({ length: conc }, async () => {
        while (next < total) {
          next++;
          sent++;
          await sendOnce(meters, batch, lat, tally, true);
        }
      }));
    }
    const secs = (Date.now() - t0) / 1000;
    saveState();
    console.log(`${mode}: ${sent} cereri × ${batch} mesaje în ${secs.toFixed(1)} s = ${(sent / secs).toFixed(1)} cereri/s · răspunsuri: ${JSON.stringify(tally)}`);
    console.log(`latență (ms): p50 ${pct(lat, 0.5).toFixed(0)} · p95 ${pct(lat, 0.95).toFixed(0)} · p99 ${pct(lat, 0.99).toFixed(0)} · max ${Math.max(...lat).toFixed(0)}`);
    console.log(`confirmate (200): contoare distincte în fișierul de stare = ${Object.keys(acked).length} (${STATE})`);
    return;
  }

  if (mode === "verify") {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL lipsește.");
    const ids = Object.keys(acked);
    const c = await connectMongo(url);
    try {
      const db = c.db();
      const meters = db.collection<{ _id: string; tel?: { Volume_m3_Total?: { t: number; v: string } } }>(process.env.METERS_COLLECTION || "meters");
      let waited = 0, depth = -1;
      for (;;) { // așteptăm să se golească cutia de intrare (max 90 s)
        depth = await db.collection(process.env.INTEGRATION_INBOX_COLLECTION || "integration_inbox").estimatedDocumentCount();
        if (depth === 0 || waited >= 90) break;
        await sleep(1000);
        waited++;
      }
      let missing = 0, stale = 0, ok = 0;
      const bad: string[] = [];
      for (let i = 0; i < ids.length; i += 1000) {
        const part = ids.slice(i, i + 1000);
        const got = new Map<string, { t: number; v: string }>();
        for await (const d of meters.find({ _id: { $in: part } as never }, { projection: { "tel.Volume_m3_Total": 1 } })) if (d.tel?.Volume_m3_Total) got.set(String(d._id), d.tel.Volume_m3_Total);
        for (const id of part) {
          const g = got.get(id), e = acked[id];
          if (!g) { missing++; if (bad.length < 5) bad.push(`${id}: lipsește`); }
          else if (g.t < e.t) { stale++; if (bad.length < 5) bad.push(`${id}: în baza de date t=${g.t}, confirmat t=${e.t}`); }
          else ok++;
        }
      }
      const readings = await db.collection(process.env.READINGS_COLLECTION || "meter_readings").countDocuments({ _id: { $in: ids } as never });
      const dead = await db.collection(process.env.INTEGRATION_DEAD_COLLECTION || "integration_dead").estimatedDocumentCount();
      console.log(`verificare: ${ids.length} contoare cu mesaje confirmate · aplicate corect ${ok} · LIPSĂ ${missing} · MAI VECHI decât confirmat ${stale} · cutia de intrare: ${depth} (după ${waited} s) · cu istoric de citiri ${readings} · respinse la aplicare ${dead}`);
      if (bad.length) console.log("exemple:", bad.join(" | "));
      if (missing || stale || depth !== 0) process.exitCode = 1;
      else console.log("OK: niciun mesaj confirmat nu s-a pierdut.");
    } finally {
      await c.close();
    }
    return;
  }
  throw new Error("folosește: load | burst | verify | auth");
}

main().catch((e) => {
  console.error(`EROARE: ${(e as Error).message}`);
  process.exit(1);
});
