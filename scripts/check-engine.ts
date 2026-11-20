/**
 * Verifică motorul de filtre și agregări față de implementări „naive”, pe date sintetice (nu atinge baza de date):   npm run check
 */
import { runFilter, NO_FILTERS, type Filters, type Sort } from "../lib/uplink-filter";
import { aggregate, makeCtx, FRESH_EDGES, RSSI_BINS, RSSI_MIN, RSSI_STEP } from "../lib/uplink-aggregate";
import { UplinkStore } from "../lib/uplink-store";
import { ALERT_FLAGS, FLAG, type ColsWire, type DatasetWire } from "../lib/uplink-shared";

let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const N = 30000;
const dict = {
  dev: Array.from({ length: 400 }, (_, i): [string, string, number] => [`${["2154", "2155", "2156"][i % 3]}_${String(70000 + i).padStart(8, "0")}_${2021 + (i % 5)}`, `eui${String(i).padStart(4, "0")}`, i % 3]),
  gw: ["gwA", "gwB", "gwC", "gwD"],
  ap: ["app1", "app2", "app3"],
  ty: ["CurrentTime", "CurrentDataMul", "HoursDataMul", "LastEventSeq"],
};
const c: ColsWire = { id: [], ts: [], dev: [], gw: [], rssi: [], snr: [], fr: [], dr: [], fl: [], fc: [], pt: [], tm: [], val: [], gn: [] };
const t0 = Date.now() - 20 * 86400_000;
for (let i = 0; i < N; i++) {
  c.id.push(i.toString(16).padStart(24, "0"));
  c.ts.push(t0 + Math.floor(rnd() * 20 * 86400_000));
  c.dev.push(Math.floor(rnd() * 400));
  c.gw.push(Math.floor(rnd() * 5) - 1);
  c.rssi.push(rnd() < 0.05 ? null : -Math.floor(70 + rnd() * 60));
  c.snr.push(rnd() < 0.05 ? null : Math.round((rnd() * 30 - 18) * 10) / 10);
  c.fr.push([868100, 868300, 868500][Math.floor(rnd() * 3)]);
  c.dr.push(rnd() < 0.03 ? -1 : Math.floor(rnd() * 6));
  c.fl.push(Math.floor(rnd() * 64));
  c.fc.push(rnd() < 0.02 ? -1 : Math.floor(rnd() * 50000));
  c.pt.push(rnd() < 0.9 ? 1 : Math.floor(rnd() * 200));
  c.tm.push(rnd() < 0.03 ? 0 : (1 << Math.floor(rnd() * 4)) | (rnd() < 0.3 ? 1 << Math.floor(rnd() * 4) : 0));
  c.val.push(rnd() < 0.1 ? null : Math.floor(rnd() * 90000));
  c.gn.push(Math.floor(rnd() * 5));
}
const st = UplinkStore.fromWire({ v: 2, gen: "g", head: N, total: N, dict, cols: c } as DatasetWire);
st.prepare();
const now = Date.now();
const F = (p: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...p });
const SORT: Sort = { key: "ts", dir: -1 };
let bad = 0;
const check = (name: string, ok: boolean, extra = "") => { if (!ok) bad++; console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? " " + extra : ""}`); };

const naive = (f: Filters): number[] => {
  const L = (s: string) => (s ? s.split("|") : []);
  const out: number[] = [];
  const num = (s: string, d: number) => (s === "" ? d : Number(s));
  const from = f.from || f.to ? (f.from ? Date.parse(f.from) : -Infinity) : f.range === "24h" ? now - 86400_000 : f.range === "7d" ? now - 7 * 86400_000 : -Infinity;
  const to = f.to ? Date.parse(f.to) : Infinity;
  for (const i of st.order) {
    const v = st.view(i);
    const model = /^(\d+)_/.exec(v.dev)?.[1], year = /_(\d{4})$/.exec(v.dev)?.[1];
    if (v.ts < from || v.ts > to) continue;
    if (f.app && !L(f.app).includes(v.app)) continue;
    if (f.gw && !(v.gw && L(f.gw).includes(v.gw))) continue;
    if (f.type && !v.types.some((t) => L(f.type).includes(t))) continue;
    if (f.dev && v.eui !== f.dev && v.dev !== f.dev) continue;
    if (f.flag) {
      const m = L(f.flag).reduce((a, k) => a | (k === "alert" ? ALERT_FLAGS : k === "batt" ? FLAG.BATT : k === "offline" ? FLAG.OFFLINE : k === "button" ? FLAG.BTN : FLAG.MAG), 0);
      if (!(v.fl & m)) continue;
    }
    if (f.dr && !L(f.dr).includes(String(v.dr))) continue;
    if (f.fr && !L(f.fr).includes(String(v.freqKhz))) continue;
    if (f.port && !L(f.port).includes(String(v.pt))) continue;
    if (f.adr === "1" && !(v.fl & FLAG.ADR)) continue;
    if (f.adr === "0" && v.fl & FLAG.ADR) continue;
    if (f.gn === "3" ? v.gn < 3 : f.gn ? v.gn !== Number(f.gn) : false) continue;
    if (f.model && !L(f.model).includes(model ?? "alt")) continue;
    if (f.year && !L(f.year).includes(year ?? "alt")) continue;
    if ((f.rssiMin || f.rssiMax) && (v.rssi == null || v.rssi < num(f.rssiMin, -Infinity) || v.rssi > num(f.rssiMax, Infinity))) continue;
    if ((f.snrMin || f.snrMax) && (v.snr == null || v.snr < num(f.snrMin, -Infinity) || v.snr > num(f.snrMax, Infinity))) continue;
    if ((f.valMin || f.valMax) && (v.val == null || v.val < num(f.valMin, -Infinity) || v.val > num(f.valMax, Infinity))) continue;
    if ((f.fcMin || f.fcMax) && (v.fc < 0 || v.fc < num(f.fcMin, -Infinity) || v.fc > num(f.fcMax, Infinity))) continue;
    out.push(i);
  }
  return out;
};

const cases: [string, Filters][] = [
  ["app multi", F({ app: "app1|app3" })], ["gw multi", F({ gw: "gwA|gwD" })], ["tip multi", F({ type: "HoursDataMul|LastEventSeq" })],
  ["flag multi", F({ flag: "batt|button" })], ["flag alert", F({ flag: "alert" })], ["dr multi", F({ dr: "0|5" })], ["frecvență", F({ fr: "868300" })],
  ["frecvență multi", F({ fr: "868100|868500" })], ["port", F({ port: "1" })], ["port altele", F({ port: "17|42" })], ["adr da", F({ adr: "1" })], ["adr nu", F({ adr: "0" })],
  ["gn=1", F({ gn: "1" })], ["gn=2", F({ gn: "2" })], ["gn=3+", F({ gn: "3" })], ["model", F({ model: "2154" })], ["model multi", F({ model: "2154|2156" })],
  ["an", F({ year: "2023" })], ["an multi", F({ year: "2021|2025" })], ["rssi interval", F({ rssiMin: "-110", rssiMax: "-90" })], ["rssi min", F({ rssiMin: "-95" })],
  ["snr interval", F({ snrMin: "-5", snrMax: "5" })], ["valoare interval", F({ valMin: "1000", valMax: "20000" })], ["fCnt interval", F({ fcMin: "100", fcMax: "5000" })],
  ["24h", F({ range: "24h" })], ["combinat", F({ app: "app2", model: "2155", dr: "3|4|5", rssiMin: "-115", adr: "1", flag: "alert", range: "7d" })],
  ["gw inexistent", F({ gw: "nu-exista" })], ["dev", F({ dev: "eui0007" })],
];
for (const [name, f] of cases) {
  const got = Array.from(runFilter(st, f, SORT, now).idx), want = naive(f);
  check(`filtru ${name.padEnd(18)}`, got.length === want.length && got.every((x, k) => x === want[k]), String(got.length));
}

// agregări: totalurile pe fiecare dimensiune trebuie să iasă egale cu numărătoarea naivă
for (const [label, f] of [["toate", F({})], ["filtrate", F({ app: "app1|app2", dr: "2|3|4", rssiMin: "-120" })]] as [string, Filters][]) {
  const idx = label === "toate" ? null : runFilter(st, f, SORT, now).idx;
  const ctx = makeCtx(st, f, now);
  const a = aggregate(st, idx, ctx);
  const rows = idx ? Array.from(idx) : Array.from({ length: st.n }, (_, i) => i);
  const sum = (x: ArrayLike<number>) => Array.from(x).reduce((p, q) => p + q, 0);
  check(`agregare ${label}: n`, a.n === rows.length);
  check(`agregare ${label}: histogramă RSSI + lipsă = n`, sum(a.rssi) + a.rssiNone === rows.length);
  check(`agregare ${label}: histogramă SNR + lipsă = n`, sum(a.snr) + a.snrNone === rows.length);
  check(`agregare ${label}: valoare + lipsă = n`, sum(a.val) + a.valNone === rows.length);
  check(`agregare ${label}: DR + lipsă = n`, sum(a.dr) + a.drNone === rows.length);
  check(`agregare ${label}: aplicații = n`, sum(a.apps) === rows.length);
  check(`agregare ${label}: gateway + fără = n`, sum(a.gws) + a.noGw === rows.length);
  check(`agregare ${label}: ore = n, zile = n`, sum(a.hour) === rows.length && sum(a.wday) === rows.length);
  check(`agregare ${label}: frecvențe = n, porturi = n, gn = n`, sum(a.freq) === rows.length && sum(a.ports) === rows.length && sum(a.gn) === rows.length);
  check(`agregare ${label}: modele = n, ani = n`, sum(a.models) === rows.length && sum(a.years) === rows.length);
  check(`agregare ${label}: ADR + fără = n`, a.flags.adr + a.flags.noAdr === rows.length);
  check(`agregare ${label}: dispozitive distincte`, a.devices === new Set(rows.map((i) => st.dev[i])).size && sum(a.fresh) === a.devices);
  const inTime = rows.filter((i) => st.ts[i] >= ctx.tStart && st.ts[i] < ctx.tStart + ctx.tN * ctx.tStep).length;
  check(`agregare ${label}: găleți de timp`, sum(a.time) === inTime, `${ctx.tN} găleți`);
  // verificare punctuală pe un tip, RSSI-bin, bateria slabă și vârsta ultimului mesaj
  check(`agregare ${label}: tip LastEventSeq`, a.types[3] === rows.filter((i) => st.tm[i] & 8).length);
  const bin5 = rows.filter((i) => st.rssi[i] === st.rssi[i] && Math.max(0, Math.min(RSSI_BINS - 1, Math.floor((st.rssi[i] - RSSI_MIN) / RSSI_STEP))) === 4).length;
  check(`agregare ${label}: bin RSSI #4`, a.rssi[4] === bin5);
  check(`agregare ${label}: baterie slabă / offline / alerte`, a.flags.batt === rows.filter((i) => st.fl[i] & FLAG.BATT).length && a.flags.alert === rows.filter((i) => st.fl[i] & ALERT_FLAGS).length);
  const last = new Map<number, number>();
  for (const i of rows) last.set(st.dev[i], Math.max(last.get(st.dev[i]) ?? -1, st.ts[i]));
  const fresh0 = Array.from(last.values()).filter((t) => now - t < FRESH_EDGES[1]).length;
  check(`agregare ${label}: dispozitive cu mesaj < 1 oră`, a.fresh[0] === fresh0);
  const topN = Array.from(a.topDev);
  check(`agregare ${label}: top dispozitive ordonat descrescător`, topN.every((x, k) => k === 0 || topN[k - 1][1] >= x[1]));
}
console.log(bad ? `\n${bad} EȘECURI` : "\nToate verificările au trecut.");
process.exit(bad ? 1 : 0);
