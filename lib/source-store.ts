import type { ColDef, SourceId, SourceWire } from "./source-shared";

/**
 * Lista unei surse (getmgdb) în browser, coloanar: coduri Int32 pentru valorile cu puține variante (dict), Float64 pentru numere / momente
 * (NaN = lipsă), șiruri pentru restul. Se salvează ca atare în IndexedDB (clonare structurată, fără JSON.parse la deschidere).
 */
export type SourceSnapshot = {
  source: SourceId;
  etag: string;
  at: number;
  n: number;
  cols: ColDef[];
  dict: Record<string, string[]>;
  codes: Record<string, Int32Array>;
  nums: Record<string, Float64Array>;
  texts: Record<string, string[]>;
};

export type SortSpec = { key: string; dir: 1 | -1 };

const collator = new Intl.Collator("ro", { numeric: true, sensitivity: "base" });

export class SourceStore {
  readonly source: SourceId;
  readonly etag: string;
  readonly at: number;
  readonly n: number;
  readonly cols: ColDef[];
  readonly byKey: Map<string, ColDef>;
  readonly dict: Record<string, string[]>;
  readonly codes: Record<string, Int32Array>;
  readonly nums: Record<string, Float64Array>;
  readonly texts: Record<string, string[]>;
  private hayCache: string[] | null = null;
  private orders = new Map<string, Int32Array>();
  private ranks = new Map<string, Int32Array>();
  private shortOk = new Map<string, boolean>();

  private constructor(s: SourceSnapshot) {
    this.source = s.source;
    this.etag = s.etag;
    this.at = s.at;
    this.n = s.n;
    this.cols = s.cols;
    this.byKey = new Map(s.cols.map((c) => [c.key, c]));
    this.dict = s.dict;
    this.codes = s.codes;
    this.nums = s.nums;
    this.texts = s.texts;
  }

  static fromWire(w: SourceWire): SourceStore {
    const n = w.total;
    const codes: SourceSnapshot["codes"] = {};
    const nums: SourceSnapshot["nums"] = {};
    const texts: SourceSnapshot["texts"] = {};
    for (const c of w.cols) {
      const a = w.data[c.key];
      if (c.kind === "dict") {
        const x = new Int32Array(n);
        for (let i = 0; i < n; i++) x[i] = (a[i] as number) ?? -1;
        codes[c.key] = x;
      } else if (c.kind === "text") {
        const x: string[] = new Array(n);
        for (let i = 0; i < n; i++) x[i] = (a[i] as string | null) ?? "";
        texts[c.key] = x;
      } else {
        const x = new Float64Array(n);
        for (let i = 0; i < n; i++) x[i] = (a[i] as number | null) ?? NaN;
        nums[c.key] = x;
      }
    }
    return new SourceStore({ source: w.source, etag: w.etag, at: w.at, n, cols: w.cols, dict: w.dict, codes, nums, texts });
  }

  snapshot(): SourceSnapshot {
    return { source: this.source, etag: this.etag, at: this.at, n: this.n, cols: this.cols, dict: this.dict, codes: this.codes, nums: this.nums, texts: this.texts };
  }

  static fromSnapshot(s: SourceSnapshot): SourceStore {
    return new SourceStore(s);
  }

  /** Eticheta unei valori dict: cele lungi (UUID) se scurtează la `short` caractere DOAR dacă după scurtare rămân distincte; altfel se arată întregi. */
  label(c: ColDef, v: string): string {
    if (!c.short || v.length <= c.short) return v;
    let ok = this.shortOk.get(c.key);
    if (ok === undefined) {
      const seen = new Set<string>();
      ok = true;
      for (const n of this.dict[c.key] ?? []) {
        const s = n.slice(0, c.short);
        if (seen.has(s)) { ok = false; break; }
        seen.add(s);
      }
      this.shortOk.set(c.key, ok);
    }
    return ok ? `${v.slice(0, c.short)}…` : v;
  }

  /** Valoarea unei celule, ca text pentru afișare („” = lipsă). */
  text(i: number, c: ColDef): string {
    if (c.kind === "dict") {
      const code = this.codes[c.key][i];
      return code < 0 ? "" : this.dict[c.key][code];
    }
    if (c.kind === "text") return this.texts[c.key][i];
    const v = this.nums[c.key][i];
    return v === v ? String(v) : "";
  }

  /** Text în minuscule din coloanele de căutare, câte unul pe rând (se construiește la prima căutare). */
  hay(): string[] {
    if (this.hayCache) return this.hayCache;
    const cols = this.cols.filter((c) => c.search && (c.kind === "text" || c.kind === "dict"));
    const out: string[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      let s = "";
      for (const c of cols) {
        const v = c.kind === "text" ? this.texts[c.key][i] : this.codes[c.key][i] < 0 ? "" : this.dict[c.key][this.codes[c.key][i]];
        if (v) s += v + "\n";
      }
      out[i] = s.toLowerCase();
    }
    this.hayCache = out;
    return out;
  }

  /** Locul fiecărei valori dintr-un dicționar în ordinea alfabetică (numerică acolo unde sunt cifre). */
  private rank(key: string): Int32Array {
    let r = this.ranks.get(key);
    if (!r) {
      const names = this.dict[key];
      const order = names.map((_, i) => i).sort((a, b) => collator.compare(names[a], names[b]));
      r = new Int32Array(names.length);
      order.forEach((code, pos) => (r![code] = pos));
      this.ranks.set(key, r);
    }
    return r;
  }

  /** Toate rândurile în ordinea cerută (lipsurile la sfârșit, la egalitate ordinea inițială). Memorată pe (coloană, sens). */
  order(sort: SortSpec): Int32Array {
    const ck = `${sort.key}:${sort.dir}`;
    const hit = this.orders.get(ck);
    if (hit) return hit;
    const c = this.byKey.get(sort.key);
    const idx = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) idx[i] = i;
    if (c) {
      const d = sort.dir;
      if (c.kind === "dict") {
        const codes = this.codes[c.key], rank = this.rank(c.key);
        idx.sort((a, b) => {
          const x = codes[a], y = codes[b];
          if (x < 0 || y < 0) return x < 0 && y < 0 ? a - b : x < 0 ? 1 : -1;
          return rank[x] === rank[y] ? a - b : d * (rank[x] - rank[y]);
        });
      } else if (c.kind === "text") {
        const t = this.texts[c.key];
        idx.sort((a, b) => {
          const x = t[a], y = t[b];
          if (x === y) return a - b;
          if (x === "") return 1;
          if (y === "") return -1;
          return d * (x < y ? -1 : 1);
        });
      } else {
        const v = this.nums[c.key];
        idx.sort((a, b) => {
          const x = v[a], y = v[b];
          if (x !== x || y !== y) return x !== x && y !== y ? a - b : x !== x ? 1 : -1;
          return x === y ? a - b : d * (x < y ? -1 : 1);
        });
      }
    }
    if (this.orders.size >= 6) this.orders.delete(this.orders.keys().next().value as string);
    this.orders.set(ck, idx);
    return idx;
  }
}
