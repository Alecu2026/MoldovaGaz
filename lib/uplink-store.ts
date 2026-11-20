import type { ColsWire, DatasetWire, DeltaWire, Dict, RowView } from "./uplink-shared";

/**
 * Lista de mesaje din browser, COLOANAR, în vectori tipizați (fără un obiect pe rând): 300.000 de rânduri ocupă ~20 MB, se filtrează în câteva ms
 * și se salvează în IndexedDB ca atare (structured clone de Float64Array / Int32Array — fără JSON.parse la deschidere).
 *
 * `order` = indecșii rândurilor sortați după timp descrescător (cele mai noi primele). Rândurile noi (delta) se interclasează în `order` în O(n).
 * Fără dependențe de React / DOM: se poate rula și în Node (vezi scripts/bench-engine.ts).
 */
export type Snapshot = {
  gen: string;
  head: number;
  total: number;
  dict: Dict;
  n: number;
  id: string[];
  ts: Float64Array;
  dev: Int32Array;
  gw: Int32Array;
  rssi: Float32Array;
  snr: Float32Array;
  fr: Int32Array;
  dr: Int8Array;
  fl: Uint8Array;
  fc: Float64Array;
  pt: Int16Array;
  tm: Int32Array;
  val: Float64Array;
  gn: Uint8Array;
  order: Int32Array;
};

function grown<T extends { length: number; set(a: ArrayLike<number>): void; subarray(a: number, b: number): ArrayLike<number> }>(ctor: new (n: number) => T, old: T, n: number, cap: number): T {
  const next = new ctor(cap);
  next.set(old.subarray(0, n));
  return next;
}

export class UplinkStore {
  gen = "";
  /** poziția în jurnalul serverului până la care avem tot (cursorul pentru delta) */
  head = 0;
  /** totalul din baza de date la ultima sincronizare */
  total = 0;
  /** crește la fiecare modificare: cheie pentru memoizare în UI */
  rev = 0;
  dict: Dict = { dev: [], gw: [], ap: [], ty: [] };
  n = 0;
  cap = 0;
  id: string[] = [];
  ts: Float64Array = new Float64Array(0);
  dev: Int32Array = new Int32Array(0);
  gw: Int32Array = new Int32Array(0);
  rssi: Float32Array = new Float32Array(0);
  snr: Float32Array = new Float32Array(0);
  fr: Int32Array = new Int32Array(0);
  dr: Int8Array = new Int8Array(0);
  fl: Uint8Array = new Uint8Array(0);
  fc: Float64Array = new Float64Array(0);
  pt: Int16Array = new Int16Array(0);
  tm: Int32Array = new Int32Array(0);
  val: Float64Array = new Float64Array(0);
  gn: Uint8Array = new Uint8Array(0);
  order: Int32Array = new Int32Array(0);
  private ids = new Set<string>();

  /** căutare: texte cu litere mici pe intrările din dicționar (se extind pe măsură ce dicționarul crește) */
  lcDev: string[] = [];
  lcGw: string[] = [];
  lcTy: string[] = [];
  /** ranguri alfabetice (pentru sortare după nume) */
  rankDev: Int32Array | null = null;
  rankGw: Int32Array | null = null;
  /** pe dispozitiv (index din dict.dev): aplicația, modelul și anul din nume („2154_00070948_2022” → model 2154, an 2022) */
  devApp: Int32Array = new Int32Array(0);
  devModel: Int16Array = new Int16Array(0);
  devYear: Int16Array = new Int16Array(0);
  models: string[] = [];
  years: string[] = [];
  private modelIdx = new Map<string, number>();
  private yearIdx = new Map<string, number>();
  private devPrepared = 0;

  static fromWire(d: DatasetWire): UplinkStore {
    const s = new UplinkStore();
    s.gen = d.gen;
    s.head = d.head;
    s.total = d.total;
    s.dict = d.dict;
    s.append(d.cols);
    s.rev = 1;
    return s;
  }

  static fromSnapshot(p: Snapshot): UplinkStore {
    const s = new UplinkStore();
    s.gen = p.gen;
    s.head = p.head;
    s.total = p.total;
    s.dict = p.dict;
    s.n = s.cap = p.n;
    s.id = p.id;
    s.ts = p.ts;
    s.dev = p.dev;
    s.gw = p.gw;
    s.rssi = p.rssi;
    s.snr = p.snr;
    s.fr = p.fr;
    s.dr = p.dr;
    s.fl = p.fl;
    s.fc = p.fc;
    s.pt = p.pt;
    s.tm = p.tm;
    s.val = p.val;
    s.gn = p.gn;
    s.order = p.order;
    s.ids = new Set(p.id);
    s.rev = 1;
    return s;
  }

  /** Copie compactă (fără capacitatea nefolosită — structured clone ar serializa tot buffer-ul, nu doar vederea). */
  snapshot(): Snapshot {
    const n = this.n;
    return {
      gen: this.gen,
      head: this.head,
      total: this.total,
      dict: this.dict,
      n,
      id: this.id.slice(0, n),
      ts: this.ts.slice(0, n),
      dev: this.dev.slice(0, n),
      gw: this.gw.slice(0, n),
      rssi: this.rssi.slice(0, n),
      snr: this.snr.slice(0, n),
      fr: this.fr.slice(0, n),
      dr: this.dr.slice(0, n),
      fl: this.fl.slice(0, n),
      fc: this.fc.slice(0, n),
      pt: this.pt.slice(0, n),
      tm: this.tm.slice(0, n),
      val: this.val.slice(0, n),
      gn: this.gn.slice(0, n),
      order: this.order.slice(0, n),
    };
  }

  /**
   * Aplică o deltă de la server. Întoarce câte rânduri noi au intrat, sau -1 dacă delta nu se potrivește cu starea noastră
   * (generație / poziție diferite, număr de rânduri care nu iese): atunci apelantul aruncă acest store și cere lista întreagă.
   */
  applyDelta(d: DeltaWire): number {
    if (d.gen !== this.gen || d.head < this.head || d.cols.id.length !== d.head - this.head) return -1;
    for (const e of d.dict.dev) this.dict.dev.push(e);
    for (const e of d.dict.gw) this.dict.gw.push(e);
    for (const e of d.dict.ap) this.dict.ap.push(e);
    for (const e of d.dict.ty) this.dict.ty.push(e);
    const added = this.append(d.cols);
    this.head = d.head;
    this.total = d.total;
    this.rev++;
    return added;
  }

  private ensureCap(need: number): void {
    if (need <= this.cap) return;
    const cap = Math.max(need, Math.floor(this.cap * 1.5) + 1024);
    const n = this.n;
    this.ts = grown(Float64Array, this.ts, n, cap);
    this.dev = grown(Int32Array, this.dev, n, cap);
    this.gw = grown(Int32Array, this.gw, n, cap);
    this.rssi = grown(Float32Array, this.rssi, n, cap);
    this.snr = grown(Float32Array, this.snr, n, cap);
    this.fr = grown(Int32Array, this.fr, n, cap);
    this.dr = grown(Int8Array, this.dr, n, cap);
    this.fl = grown(Uint8Array, this.fl, n, cap);
    this.fc = grown(Float64Array, this.fc, n, cap);
    this.pt = grown(Int16Array, this.pt, n, cap);
    this.tm = grown(Int32Array, this.tm, n, cap);
    this.val = grown(Float64Array, this.val, n, cap);
    this.gn = grown(Uint8Array, this.gn, n, cap);
    this.cap = cap;
  }

  /** Adaugă rândurile (sar peste cele deja prezente, după id) și le interclasează în `order`. */
  private append(c: ColsWire): number {
    const m = c.id.length;
    if (m === 0) return 0;
    this.ensureCap(this.n + m);
    const k0 = this.n;
    let w = k0;
    for (let j = 0; j < m; j++) {
      const id = c.id[j];
      if (this.ids.has(id)) continue;
      this.ids.add(id);
      this.id[w] = id;
      this.ts[w] = c.ts[j];
      this.dev[w] = c.dev[j];
      this.gw[w] = c.gw[j];
      this.rssi[w] = c.rssi[j] ?? NaN;
      this.snr[w] = c.snr[j] ?? NaN;
      this.fr[w] = c.fr[j];
      this.dr[w] = c.dr[j];
      this.fl[w] = c.fl[j];
      this.fc[w] = c.fc[j];
      this.pt[w] = c.pt[j];
      this.tm[w] = c.tm[j];
      this.val[w] = c.val[j] ?? NaN;
      this.gn[w] = c.gn[j];
      w++;
    }
    this.n = w;
    if (w > k0) this.mergeOrder(k0);
    return w - k0;
  }

  /** Rândurile k0..n-1 sunt noi: le sortăm (timp desc, apoi poziție desc) și le interclasăm în `order`. */
  private mergeOrder(k0: number): void {
    const n = this.n;
    const ts = this.ts;
    const m = n - k0;
    const add = new Int32Array(m);
    let ascending = true; // serverul trimite în ordinea sosirii ⇒ de obicei deja crescător după timp
    for (let i = 0; i < m; i++) {
      add[m - 1 - i] = k0 + i;
      if (i > 0 && ts[k0 + i] < ts[k0 + i - 1]) ascending = false;
    }
    if (!ascending) add.sort((a, b) => ts[b] - ts[a] || b - a);
    if (k0 === 0) {
      this.order = add;
      return;
    }
    const old = this.order;
    const out = new Int32Array(n);
    let i = 0,
      j = 0,
      o = 0;
    while (i < old.length && j < m) {
      const a = old[i],
        b = add[j];
      if (ts[a] > ts[b] || (ts[a] === ts[b] && a > b)) {
        out[o++] = a;
        i++;
      } else {
        out[o++] = b;
        j++;
      }
    }
    while (i < old.length) out[o++] = old[i++];
    while (j < m) out[o++] = add[j++];
    this.order = out;
  }

  /** Pregătește textele (litere mici) și rangurile alfabetice ale dicționarelor, doar pentru intrările noi. */
  prepare(): void {
    const { dev, gw, ap, ty } = this.dict;
    for (let i = this.lcDev.length; i < dev.length; i++) this.lcDev[i] = `${dev[i][0]} ${dev[i][1]} ${ap[dev[i][2]] ?? ""}`.toLowerCase();
    for (let i = this.lcGw.length; i < gw.length; i++) this.lcGw[i] = gw[i].toLowerCase();
    for (let i = this.lcTy.length; i < ty.length; i++) this.lcTy[i] = ty[i].toLowerCase();
    if (this.devPrepared < dev.length) this.prepareDevices();
    if (!this.rankDev || this.rankDev.length !== dev.length) this.rankDev = ranks(dev.map((e) => `${e[0]} ${e[1]}`));
    if (!this.rankGw || this.rankGw.length !== gw.length) this.rankGw = ranks(gw);
  }

  private prepareDevices(): void {
    const dev = this.dict.dev;
    const grow = <T extends Int32Array | Int16Array>(old: T, Ctor: new (n: number) => T): T => {
      const next = new Ctor(dev.length);
      next.set(old);
      return next;
    };
    this.devApp = grow(this.devApp, Int32Array);
    this.devModel = grow(this.devModel, Int16Array);
    this.devYear = grow(this.devYear, Int16Array);
    const intern = (map: Map<string, number>, arr: string[], v: string) => {
      let i = map.get(v);
      if (i === undefined) {
        i = arr.length;
        arr.push(v);
        map.set(v, i);
      }
      return i;
    };
    for (let d = this.devPrepared; d < dev.length; d++) {
      const m = /^(\d{3,5})_\d+_(\d{4})$/.exec(dev[d][0]);
      this.devApp[d] = dev[d][2];
      this.devModel[d] = intern(this.modelIdx, this.models, m ? m[1] : "alt");
      this.devYear[d] = intern(this.yearIdx, this.years, m ? m[2] : "alt");
    }
    this.devPrepared = dev.length;
  }

  view(i: number): RowView {
    const d = this.dict.dev[this.dev[i]];
    const g = this.gw[i];
    const m = this.tm[i];
    const types: string[] = [];
    for (let b = 0; b < 32; b++) if (m & (1 << b)) types.push(this.dict.ty[b] ?? "?");
    const r = this.rssi[i],
      s = this.snr[i],
      v = this.val[i];
    return {
      id: this.id[i],
      ts: this.ts[i],
      dev: d?.[0] ?? "",
      eui: d?.[1] ?? "",
      app: d ? this.dict.ap[d[2]] ?? "" : "",
      gw: g >= 0 ? this.dict.gw[g] ?? null : null,
      gn: this.gn[i],
      rssi: r === r ? r : null,
      snr: s === s ? s : null,
      freqKhz: this.fr[i],
      dr: this.dr[i],
      fl: this.fl[i],
      fc: this.fc[i],
      pt: this.pt[i],
      types,
      val: v === v ? v : null,
    };
  }
}

function ranks(names: string[]): Int32Array {
  const idx = names.map((_, i) => i).sort((a, b) => names[a].localeCompare(names[b], "ro", { numeric: true, sensitivity: "base" }));
  const r = new Int32Array(names.length);
  for (let k = 0; k < idx.length; k++) r[idx[k]] = k;
  return r;
}
