import { METER_NAME, type ColsWire, type DatasetWire, type DeltaWire, type Dict, type RowView } from "./meter-shared";

/**
 * Lista de contoare din browser, COLOANAR, în vectori tipizați (fără un obiect pe rând): zeci de mii de contoare ocupă câțiva MB, se filtrează în
 * câteva ms și se salvează în IndexedDB ca atare (structured clone). Spre deosebire de un jurnal de mesaje, un contor își SCHIMBĂ starea: delta
 * aduce rândurile noi / modificate (după id) și le suprascrie pe loc. `order` = indecșii sortați după ultima citire descrescător, refăcut după fiecare
 * delta care schimbă ceva. Fără dependențe de React / DOM: se poate rula și în Node (vezi scripts/check-engine.ts).
 */
export type Snapshot = {
  gen: string;
  head: number;
  total: number;
  dict: Dict;
  n: number;
  id: string[]; nm: string[]; eu: string[]; q: string[];
  ts: Float64Array;
  ap: Int32Array; gw: Int32Array; br: Int32Array; ct: Int32Array; pf: Int32Array;
  rssi: Float32Array; snr: Float32Array; bat: Float32Array;
  fr: Int32Array; fl: Uint8Array; fc: Float64Array; pt: Int16Array; tm: Int32Array;
  val: Float64Array; dc: Float64Array; mc: Float64Array; dt: Float64Array; mt: Float64Array;
  la: Float64Array; lo: Float64Array;
};

type F64 = Float64Array;
type F32 = Float32Array;
type I32 = Int32Array;
type I16 = Int16Array;
type U8 = Uint8Array;
function grow<T extends F64 | F32 | I32 | I16 | U8>(Ctor: new (n: number) => T, old: T, n: number, cap: number): T {
  const next = new Ctor(cap);
  next.set(old.subarray(0, n));
  return next;
}
const collator = new Intl.Collator("ro", { numeric: true, sensitivity: "base" });

export class MeterStore {
  gen = "";
  /** ultimul `seq` de pe server inclus (cursorul pentru delta) */
  head = 0;
  total = 0;
  /** crește la fiecare modificare: cheie pentru memoizare în UI */
  rev = 0;
  dict: Dict = { ap: [], gw: [], ty: [], br: [], ct: [], pf: [] };
  n = 0;
  cap = 0;
  id: string[] = []; nm: string[] = []; eu: string[] = []; q: string[] = [];
  /** textul de căutare, cu litere mici: nume + devEUI + număr radio / cont / adresă / consumator */
  lq: string[] = [];
  /** doar nume + devEUI, cu litere mici (filtrul din antetul coloanei „Contor”) */
  ln: string[] = [];
  ts: F64 = new Float64Array(0);
  ap: I32 = new Int32Array(0); gw: I32 = new Int32Array(0); br: I32 = new Int32Array(0); ct: I32 = new Int32Array(0); pf: I32 = new Int32Array(0);
  rssi: F32 = new Float32Array(0); snr: F32 = new Float32Array(0); bat: F32 = new Float32Array(0);
  fr: I32 = new Int32Array(0); fl: U8 = new Uint8Array(0); fc: F64 = new Float64Array(0); pt: I16 = new Int16Array(0); tm: I32 = new Int32Array(0);
  val: F64 = new Float64Array(0); dc: F64 = new Float64Array(0); mc: F64 = new Float64Array(0); dt: F64 = new Float64Array(0); mt: F64 = new Float64Array(0);
  /** latitudine / longitudine în grade (NaN = fără coordonate) */
  la: F64 = new Float64Array(0); lo: F64 = new Float64Array(0);
  /** modelul și anul din nume (ex. S2154_00070948_2022 → 2154 / 2022), ca indici în `models` / `years` */
  model: I16 = new Int16Array(0);
  year: I16 = new Int16Array(0);
  models: string[] = [];
  years: string[] = [];
  order: I32 = new Int32Array(0);
  private idx = new Map<string, number>();
  private modelIdx = new Map<string, number>();
  private yearIdx = new Map<string, number>();
  lcGw: string[] = [];
  lcTy: string[] = [];
  private rankCache: { rev: number; nm: I32 | null; gw: I32 | null; br: I32 | null } = { rev: -1, nm: null, gw: null, br: null };

  static fromWire(d: DatasetWire): MeterStore {
    const s = new MeterStore();
    s.gen = d.gen;
    s.head = d.head;
    s.total = d.total;
    s.dict = d.dict;
    s.upsert(d.cols);
    s.rev = 1;
    return s;
  }

  static fromSnapshot(p: Snapshot): MeterStore {
    const s = new MeterStore();
    s.gen = p.gen; s.head = p.head; s.total = p.total; s.dict = p.dict;
    s.n = s.cap = p.n;
    s.id = p.id; s.nm = p.nm; s.eu = p.eu; s.q = p.q;
    s.ts = p.ts; s.ap = p.ap; s.gw = p.gw; s.br = p.br; s.ct = p.ct; s.pf = p.pf;
    s.rssi = p.rssi; s.snr = p.snr; s.bat = p.bat; s.fr = p.fr; s.fl = p.fl; s.fc = p.fc; s.pt = p.pt; s.tm = p.tm;
    s.val = p.val; s.dc = p.dc; s.mc = p.mc; s.dt = p.dt ?? new Float64Array(p.n).fill(NaN); s.mt = p.mt ?? new Float64Array(p.n).fill(NaN); s.la = p.la; s.lo = p.lo;
    s.model = new Int16Array(p.n);
    s.year = new Int16Array(p.n);
    for (let i = 0; i < p.n; i++) {
      s.lq[i] = `${p.nm[i]} ${p.eu[i]} ${p.q[i]}`.toLowerCase();
      s.ln[i] = `${p.nm[i]} ${p.eu[i]}`.toLowerCase();
      s.setModelYear(i);
    }
    s.idx = new Map(p.id.map((id, i) => [id, i]));
    s.sortOrder();
    s.rev = 1;
    return s;
  }

  /** Copie compactă (fără capacitatea nefolosită — structured clone ar serializa tot buffer-ul, nu doar vederea). */
  snapshot(): Snapshot {
    const n = this.n;
    return {
      gen: this.gen, head: this.head, total: this.total, dict: this.dict, n,
      id: this.id.slice(0, n), nm: this.nm.slice(0, n), eu: this.eu.slice(0, n), q: this.q.slice(0, n),
      ts: this.ts.slice(0, n), ap: this.ap.slice(0, n), gw: this.gw.slice(0, n), br: this.br.slice(0, n), ct: this.ct.slice(0, n), pf: this.pf.slice(0, n),
      rssi: this.rssi.slice(0, n), snr: this.snr.slice(0, n), bat: this.bat.slice(0, n), fr: this.fr.slice(0, n), fl: this.fl.slice(0, n),
      fc: this.fc.slice(0, n), pt: this.pt.slice(0, n), tm: this.tm.slice(0, n), val: this.val.slice(0, n), dc: this.dc.slice(0, n), mc: this.mc.slice(0, n), dt: this.dt.slice(0, n), mt: this.mt.slice(0, n), la: this.la.slice(0, n), lo: this.lo.slice(0, n),
    };
  }

  /**
   * Aplică o deltă de la server. Întoarce câte rânduri au fost noi sau modificate, sau -1 dacă delta nu se potrivește cu starea noastră
   * (generație diferită, cursor în urmă): atunci apelantul aruncă acest store și cere lista întreagă.
   */
  applyDelta(d: DeltaWire): number {
    if (d.gen !== this.gen || d.head < this.head) return -1;
    for (const k of ["ap", "gw", "ty", "br", "ct", "pf"] as const) for (const e of d.dict[k]) this.dict[k].push(e);
    const changed = this.upsert(d.cols);
    this.head = d.head;
    this.total = d.total;
    this.rev++;
    return changed;
  }

  private ensureCap(need: number): void {
    if (need <= this.cap) return;
    const cap = Math.max(need, Math.floor(this.cap * 1.5) + 1024);
    const n = this.n;
    this.ts = grow(Float64Array, this.ts, n, cap);
    this.ap = grow(Int32Array, this.ap, n, cap); this.gw = grow(Int32Array, this.gw, n, cap); this.br = grow(Int32Array, this.br, n, cap);
    this.ct = grow(Int32Array, this.ct, n, cap); this.pf = grow(Int32Array, this.pf, n, cap);
    this.rssi = grow(Float32Array, this.rssi, n, cap); this.snr = grow(Float32Array, this.snr, n, cap); this.bat = grow(Float32Array, this.bat, n, cap);
    this.fr = grow(Int32Array, this.fr, n, cap); this.fl = grow(Uint8Array, this.fl, n, cap); this.fc = grow(Float64Array, this.fc, n, cap);
    this.pt = grow(Int16Array, this.pt, n, cap); this.tm = grow(Int32Array, this.tm, n, cap);
    this.val = grow(Float64Array, this.val, n, cap); this.dc = grow(Float64Array, this.dc, n, cap); this.mc = grow(Float64Array, this.mc, n, cap); this.dt = grow(Float64Array, this.dt, n, cap); this.mt = grow(Float64Array, this.mt, n, cap);
    this.la = grow(Float64Array, this.la, n, cap); this.lo = grow(Float64Array, this.lo, n, cap);
    this.model = grow(Int16Array, this.model, n, cap); this.year = grow(Int16Array, this.year, n, cap);
    this.cap = cap;
  }

  private setModelYear(i: number): void {
    const m = METER_NAME.exec(this.nm[i]);
    const intern = (map: Map<string, number>, arr: string[], v: string) => {
      let k = map.get(v);
      if (k === undefined) { k = arr.length; arr.push(v); map.set(v, k); }
      return k;
    };
    this.model[i] = intern(this.modelIdx, this.models, m ? m[1] : "alt");
    this.year[i] = intern(this.yearIdx, this.years, m ? m[3] : "alt");
  }

  /** Adaugă rândurile noi și suprascrie pe cele existente (după id). Întoarce câte rânduri au fost atinse. */
  private upsert(c: ColsWire): number {
    const m = c.id.length;
    if (m === 0) return 0;
    this.ensureCap(this.n + m);
    for (let j = 0; j < m; j++) {
      const id = c.id[j];
      let i = this.idx.get(id);
      if (i === undefined) {
        i = this.n++;
        this.idx.set(id, i);
        this.id[i] = id;
      }
      this.nm[i] = c.nm[j]; this.eu[i] = c.eu[j]; this.q[i] = c.q[j];
      this.lq[i] = `${c.nm[j]} ${c.eu[j]} ${c.q[j]}`.toLowerCase();
      this.ln[i] = `${c.nm[j]} ${c.eu[j]}`.toLowerCase();
      this.ts[i] = c.ts[j]; this.ap[i] = c.ap[j]; this.gw[i] = c.gw[j]; this.br[i] = c.br[j]; this.ct[i] = c.ct[j]; this.pf[i] = c.pf[j];
      this.rssi[i] = c.rssi[j] ?? NaN; this.snr[i] = c.snr[j] ?? NaN; this.bat[i] = c.bat[j] ?? NaN;
      this.fr[i] = c.fr[j]; this.fl[i] = c.fl[j]; this.fc[i] = c.fc[j]; this.pt[i] = c.pt[j]; this.tm[i] = c.tm[j];
      this.val[i] = c.val[j] ?? NaN; this.dc[i] = c.dc[j] ?? NaN; this.mc[i] = c.mc[j] ?? NaN; this.dt[i] = c.dt?.[j] ?? NaN; this.mt[i] = c.mt?.[j] ?? NaN;
      this.la[i] = c.la[j] ?? NaN; this.lo[i] = c.lo[j] ?? NaN;
      this.setModelYear(i);
    }
    this.sortOrder();
    return m;
  }

  /** Cele mai recente citiri primele; la egalitate, rândul mai nou adăugat primul. */
  private sortOrder(): void {
    const n = this.n, ts = this.ts;
    const o = new Int32Array(n);
    for (let i = 0; i < n; i++) o[i] = i;
    o.sort((a, b) => ts[b] - ts[a] || b - a);
    this.order = o;
  }

  /** Pregătește textele (litere mici) și rangurile alfabetice ale dicționarelor, doar pentru intrările noi. */
  prepare(): void {
    const { gw, ty } = this.dict;
    for (let i = this.lcGw.length; i < gw.length; i++) this.lcGw[i] = gw[i].toLowerCase();
    for (let i = this.lcTy.length; i < ty.length; i++) this.lcTy[i] = ty[i].toLowerCase();
  }

  /** Rang alfabetic (pentru sortare după nume / filială / concentrator), memorat până la următoarea modificare. */
  ranks(): { nm: I32; gw: I32; br: I32 } {
    const c = this.rankCache;
    if (c.rev === this.rev && c.nm && c.gw && c.br) return { nm: c.nm, gw: c.gw, br: c.br };
    const byDict = (names: string[]) => {
      const idx = names.map((_, i) => i).sort((a, b) => collator.compare(names[a], names[b]));
      const r = new Int32Array(names.length);
      for (let k = 0; k < idx.length; k++) r[idx[k]] = k;
      return r;
    };
    const n = this.n;
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const nm = this.nm;
    idx.sort((a, b) => collator.compare(nm[a], nm[b]));
    const rn = new Int32Array(n);
    for (let k = 0; k < n; k++) rn[idx[k]] = k;
    const out = { rev: this.rev, nm: rn, gw: byDict(this.dict.gw), br: byDict(this.dict.br) };
    this.rankCache = out;
    return out;
  }

  view(i: number): RowView {
    const m = this.tm[i];
    const types: string[] = [];
    for (let b = 0; b < 32; b++) if (m & (1 << b)) types.push(this.dict.ty[b] ?? "?");
    const g = this.gw[i], br = this.br[i], ct = this.ct[i], pf = this.pf[i], ap = this.ap[i];
    const nn = (x: number) => (x === x ? x : null);
    return {
      id: this.id[i], ts: this.ts[i], name: this.nm[i], eui: this.eu[i],
      app: ap >= 0 ? this.dict.ap[ap] ?? "" : "", gw: g >= 0 ? this.dict.gw[g] ?? null : null,
      rssi: nn(this.rssi[i]), snr: nn(this.snr[i]), freqKhz: this.fr[i], fl: this.fl[i], fc: this.fc[i], pt: this.pt[i], types,
      val: nn(this.val[i]), bat: nn(this.bat[i]), dc: nn(this.dc[i]), mc: nn(this.mc[i]), lat: nn(this.la[i]), lon: nn(this.lo[i]),
      branch: br >= 0 ? this.dict.br[br] ?? null : null, city: ct >= 0 ? this.dict.ct[ct] ?? null : null, profile: pf >= 0 ? this.dict.pf[pf] ?? null : null,
    };
  }
}
