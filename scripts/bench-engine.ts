/**
 * Măsoară motorul din browser (store coloanar + filtre + delta) pe date sintetice, în memorie — nu atinge baza de date.
 *   npm run bench            (300.000 rânduri)      npm run bench -- 1000000
 */
import type { ColsWire, DatasetWire, DeltaWire } from "../lib/uplink-shared";
import { runFilter, NO_FILTERS, type Filters } from "../lib/uplink-filter";
import { UplinkStore } from "../lib/uplink-store";

const N = Number(process.argv[2]) || 300_000;
const DEVICES = 2000;
const GATEWAYS = 12;
const TYPES = ["CurrentTime", "CurrentDataMul", "HoursDataMul", "LastEventSeq", "Battery", "Status"];

const dict = {
  dev: Array.from({ length: DEVICES }, (_, i): [string, string, number] => [`${2154 + (i % 5)}_${String(70000 + i).padStart(8, "0")}_2024`, (0x001a79881800 + i).toString(16).padStart(16, "0"), i % 2]),
  gw: Array.from({ length: GATEWAYS }, (_, i) => `M${i}_Comrat_Gaz`),
  ap: ["App_Comrat_Gaz_ABP_jooby", "App_Cimislia"],
  ty: TYPES,
};

function cols(n: number, t0: number, idStart: number): ColsWire {
  const c: ColsWire = { id: [], ts: [], dev: [], gw: [], rssi: [], snr: [], fr: [], dr: [], fl: [], fc: [], pt: [], tm: [], val: [], gn: [] };
  let seed = 12345 + idStart;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < n; i++) {
    c.id.push((idStart + i).toString(16).padStart(24, "0"));
    c.ts.push(t0 + i * 1000); // ordinea sosirii ≈ ordinea timpului
    c.dev.push(Math.floor(rnd() * DEVICES));
    c.gw.push(rnd() < 0.02 ? -1 : Math.floor(rnd() * GATEWAYS));
    c.rssi.push(rnd() < 0.02 ? null : -(80 + Math.floor(rnd() * 45)));
    c.snr.push(Math.round((rnd() * 20 - 12) * 10) / 10);
    c.fr.push(868100 + 200 * Math.floor(rnd() * 3));
    c.dr.push(Math.floor(rnd() * 6));
    c.fl.push((rnd() < 0.5 ? 1 : 0) | (rnd() < 0.02 ? 2 : 0) | (rnd() < 0.01 ? 16 : 0) | (rnd() < 0.7 ? 32 : 0));
    c.fc.push(Math.floor(rnd() * 30000));
    c.pt.push(1);
    c.tm.push(1 << Math.floor(rnd() * TYPES.length));
    c.val.push(rnd() < 0.1 ? null : Math.floor(rnd() * 20000));
    c.gn.push(1 + Math.floor(rnd() * 3));
  }
  return c;
}

const time = <T,>(label: string, fn: () => T, runs = 5): T => {
  let out!: T;
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} ${ms[Math.floor(ms.length / 2)].toFixed(1).padStart(8)} ms (mediană din ${runs})`);
  return out;
};

const t0 = Date.now() - N * 1000;
const wire: DatasetWire = { v: 2, gen: "g", head: N, total: N, dict, cols: cols(N, t0, 0) };
const json = JSON.stringify(wire);
console.log(`${N.toLocaleString("ro-RO")} rânduri · JSON ${(json.length / 1e6).toFixed(1)} MB`);

const st = time("fromWire (decodare + sortare)", () => UplinkStore.fromWire(JSON.parse(json) as DatasetWire), 3);
const f = (p: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...p });

time("fără filtre", () => runFilter(st, NO_FILTERS, { key: "ts", dir: -1 }));
time("ultima oră", () => runFilter(st, f({ range: "1h" }), { key: "ts", dir: -1 }));
time("aplicație + gateway + tip", () => runFilter(st, f({ app: "App_Cimislia", gw: "M3_Comrat_Gaz", type: "Battery" }), { key: "ts", dir: -1 }));
time("căutare „comrat 0007”", () => runFilter(st, f({ q: "comrat 0007" }), { key: "ts", dir: -1 }));
time("căutare numerică „28482”", () => runFilter(st, f({ q: "28482" }), { key: "ts", dir: -1 }));
time("doar alerte", () => runFilter(st, f({ flag: "alert" }), { key: "ts", dir: -1 }));
time("sortare după valoare (toate rândurile)", () => runFilter(st, NO_FILTERS, { key: "val", dir: -1 }), 3);
time("sortare după dispozitiv (toate rândurile)", () => runFilter(st, NO_FILTERS, { key: "dev", dir: 1 }), 3);

const snap = time("snapshot() pentru IndexedDB (copie compactă)", () => st.snapshot(), 3);
time("fromSnapshot() la deschidere din IndexedDB", () => UplinkStore.fromSnapshot(snap), 3);

// delta: 50 mesaje noi peste lista de 300k
let head = N;
const delta = time(
  "applyDelta(+50 mesaje) peste lista întreagă",
  () => {
    const d: DeltaWire = { v: 2, gen: "g", head: head + 50, total: head + 50, dict: { dev: [], gw: [], ap: [], ty: [] }, cols: cols(50, t0 + head * 1000, head) };
    const added = st.applyDelta(d);
    head += 50;
    return added;
  },
  5,
);
console.log(`  → rânduri adăugate la ultima delta: ${delta}; total acum ${st.n}`);
const mem = process.memoryUsage();
console.log(`heap ${(mem.heapUsed / 1e6).toFixed(0)} MB · arrayBuffers ${(mem.arrayBuffers / 1e6).toFixed(0)} MB`);
