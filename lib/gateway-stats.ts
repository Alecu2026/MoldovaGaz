/**
 * Statistici pe ANTENE, pe zile (logică pură, fără baze de date; testată în `npm run check`).
 *
 * Ziua = ziua UTC. Pentru fiecare (antenă, zi) se țin: mesaje (n), sume RSSI / SNR (cu numărul de valori) și „contoare-zile” (dv): de câte ori a fost auzit, în ziua aceea,
 * un contor NOU pentru antenă (prima lui apariție din zi). Suma dv pe o perioadă = contoare-zile; contoarele DISTINCTE auzite în perioadă se calculează din perechile
 * antenă × contor (ultimul moment auzit), vezi lib/services/gateways.ts.
 */
export const DAY = 86_400_000;
export const dayOf = (t: number): number => Math.floor(t / DAY) * DAY;

export type DayAgg = { g: string; d: number; n: number; nr: number; rs: number; ns: number; ss: number; dv: number };
export type Hit = { g: string; m: string; t: number; rssi: number | null; snr: number | null };

/**
 * Dintr-un lot de mesaje → agregate pe (antenă, zi). `ld` = ultima zi deja numărată pentru fiecare pereche antenă × contor (din baza de date): o pereche se numără
 * o singură dată pe zi, la prima apariție din ziua respectivă. Întoarce și noua „ultimă zi” a fiecărei perechi (de scris în baza de date).
 */
export function foldDays(hits: Hit[], ld: Map<string, number>): { days: Map<string, DayAgg>; pairLd: Map<string, number> } {
  const days = new Map<string, DayAgg>();
  const pairDays = new Map<string, Set<number>>();
  for (const h of hits) {
    const d = dayOf(h.t);
    const dk = `${h.g}|${d}`;
    let a = days.get(dk);
    if (!a) days.set(dk, (a = { g: h.g, d, n: 0, nr: 0, rs: 0, ns: 0, ss: 0, dv: 0 }));
    a.n++;
    if (h.rssi !== null) { a.nr++; a.rs += h.rssi; }
    if (h.snr !== null) { a.ns++; a.ss += h.snr; }
    const pk = `${h.g}|${h.m}`;
    let s = pairDays.get(pk);
    if (!s) pairDays.set(pk, (s = new Set()));
    s.add(d);
  }
  const pairLd = new Map<string, number>();
  for (const [pk, set] of pairDays) {
    const g = pk.slice(0, pk.indexOf("|"));
    let last = ld.get(pk) ?? -Infinity;
    for (const d of [...set].sort((a, b) => a - b)) {
      if (d > last) { (days.get(`${g}|${d}`) as DayAgg).dv++; last = d; }
    }
    pairLd.set(pk, last);
  }
  return { days, pairLd };
}

export type GwSum = { id: string; name: string; la: number | null; lo: number | null; state: "on" | "slow" | "off"; last: number; devices: number; primary: number; exclusive: number; rssi: number | null; snr: number | null };
export type StatQuery = { from: number; to: number; state: string; q: string; minDevices: number; sort: string; gw: string };
export type StatRow = GwSum & { messages: number; devicesIn: number; perDevice: number | null; rssiIn: number | null; snrIn: number | null; activeDays: number };
export type DayPoint = { d: number; n: number; dv: number; gws: number; rssi: number | null; snr: number | null };
export type Stats = {
  from: number; to: number;
  rows: StatRow[];
  days: DayPoint[];
  totals: { gateways: number; on: number; slow: number; off: number; messages: number; devices: number; avgPerDevice: number | null; rssi: number | null; singles: number };
  gw: { id: string; name: string; days: DayPoint[] } | null;
};
export const MAX_DAYS = 120;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Perioada, ca zile întregi (cel mult MAX_DAYS, de la sfârșit). */
export function dayRange(from: number, to: number): number[] {
  const a = dayOf(Math.min(from, to)), b = dayOf(Math.max(from, to));
  const n = Math.min(MAX_DAYS, Math.round((b - a) / DAY) + 1);
  return Array.from({ length: n }, (_, i) => b - (n - 1 - i) * DAY);
}

/** Antenele din filtru, cu eficiența fiecăreia pe perioadă + seria pe zile (toate antenele filtrate, sau doar `gw`). */
export function buildStats(sum: GwSum[], dayDocs: DayAgg[], devicesIn: Map<string, number>, q: StatQuery): Stats {
  const range = dayRange(q.from, q.to);
  const lo = range[0], hi = range[range.length - 1];
  const per = new Map<string, DayAgg[]>();
  for (const d of dayDocs) {
    if (d.d < lo || d.d > hi) continue;
    const l = per.get(d.g);
    if (l) l.push(d); else per.set(d.g, [d]);
  }
  const needle = q.q.trim().toLowerCase();
  const rows: StatRow[] = [];
  for (const g of sum) {
    if (q.state && g.state !== q.state) continue;
    if (needle && !g.name.toLowerCase().includes(needle) && !g.id.toLowerCase().includes(needle)) continue;
    const ds = per.get(g.id) ?? [];
    let messages = 0, nr = 0, rs = 0, ns = 0, ss = 0;
    for (const d of ds) { messages += d.n; nr += d.nr; rs += d.rs; ns += d.ns; ss += d.ss; }
    const dIn = devicesIn.get(g.id) ?? 0;
    if (dIn < q.minDevices) continue;
    rows.push({ ...g, messages, devicesIn: dIn, perDevice: dIn > 0 ? r1(messages / dIn) : null, rssiIn: nr ? r1(rs / nr) : null, snrIn: ns ? r1(ss / ns) : null, activeDays: ds.filter((d) => d.n > 0).length });
  }
  const by: Record<string, (a: StatRow, b: StatRow) => number> = {
    devices: (a, b) => b.devicesIn - a.devicesIn || b.messages - a.messages,
    messages: (a, b) => b.messages - a.messages,
    rssi: (a, b) => (b.rssiIn ?? -999) - (a.rssiIn ?? -999),
    last: (a, b) => b.last - a.last,
    name: (a, b) => a.name.localeCompare(b.name, "ro", { numeric: true }),
    perdevice: (a, b) => (b.perDevice ?? -1) - (a.perDevice ?? -1),
  };
  rows.sort(by[q.sort] ?? by.devices);

  const ids = new Set(rows.map((r) => r.id));
  const series = (only: (g: string) => boolean): DayPoint[] =>
    range.map((d) => {
      let n = 0, dv = 0, nr = 0, rs = 0, ns = 0, ss = 0, gws = 0;
      for (const [g, list] of per) {
        if (!only(g)) continue;
        for (const x of list) if (x.d === d) { n += x.n; dv += x.dv; nr += x.nr; rs += x.rs; ns += x.ns; ss += x.ss; if (x.n > 0) gws++; }
      }
      return { d, n, dv, gws, rssi: nr ? r1(rs / nr) : null, snr: ns ? r1(ss / ns) : null };
    });
  const days = series((g) => ids.has(g));
  const pick = q.gw ? rows.find((r) => r.id === q.gw) ?? sum.find((r) => r.id === q.gw) : undefined;
  const totalMsgs = rows.reduce((a, r) => a + r.messages, 0);
  const rssiN = rows.reduce((a, r) => a + (r.rssiIn !== null ? r.messages : 0), 0);
  const rssiS = rows.reduce((a, r) => a + (r.rssiIn !== null ? r.rssiIn * r.messages : 0), 0);
  const devices = rows.reduce((a, r) => a + r.devicesIn, 0);
  return {
    from: lo, to: hi + DAY - 1, rows, days,
    totals: {
      gateways: rows.length, on: rows.filter((r) => r.state === "on").length, slow: rows.filter((r) => r.state === "slow").length, off: rows.filter((r) => r.state === "off").length,
      messages: totalMsgs, devices, avgPerDevice: devices ? r1(totalMsgs / devices) : null, rssi: rssiN ? r1(rssiS / rssiN) : null, singles: rows.filter((r) => r.exclusive > 0).length,
    },
    gw: pick ? { id: pick.id, name: pick.name, days: series((g) => g === pick.id) } : null,
  };
}
