import { EMPTY_LABEL, EMPTY_TOKEN, type ColDef } from "./source-shared";
import type { SortSpec, SourceStore } from "./source-store";

/**
 * Filtrele paginilor pe sursă. Aceleași reguli ca la pagina principală: între filtre diferite ȘI, între valorile aceluiași filtru SAU.
 *  - q: căutare liberă (toate cuvintele trebuie să apară, în orice coloană de căutare);
 *  - sel[coloană]: valorile alese dintr-o listă (dict); EMPTY_TOKEN = rândurile fără valoare;
 *  - txt[coloană]: „conține” pe o coloană text;
 *  - min/max[coloană]: interval pe un număr sau o dată (date: yyyy-mm-dd, zilele de la / până la inclusiv).
 * Totul rămâne în URL (q, s.<col>, t.<col>, min.<col>, max.<col>, sort, dir, view).
 */
export type SFilters = {
  q: string;
  sel: Record<string, string[]>;
  txt: Record<string, string>;
  min: Record<string, string>;
  max: Record<string, string>;
};
export const NO_SFILTERS: SFilters = { q: "", sel: {}, txt: {}, min: {}, max: {} };

/* ───── listă ↔ text (în URL): „|” separă valorile, „\” își scapă separatorul ───── */
export const joinList = (l: string[]) => l.map((v) => v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")).join("|");
export function splitList(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) cur += s[++i];
    else if (ch === "|") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.filter((x) => x !== "");
}

/* ───── URL ───── */
export function filtersFromEntries(entries: Iterable<[string, string]>): SFilters {
  const f: SFilters = { q: "", sel: {}, txt: {}, min: {}, max: {} };
  for (const [k, v] of entries) {
    if (!v) continue;
    if (k === "q") f.q = v;
    else if (k.startsWith("s.")) { const l = splitList(v); if (l.length) f.sel[k.slice(2)] = l; }
    else if (k.startsWith("t.")) f.txt[k.slice(2)] = v;
    else if (k.startsWith("min.")) f.min[k.slice(4)] = v;
    else if (k.startsWith("max.")) f.max[k.slice(4)] = v;
  }
  return f;
}
export function sortFromEntries(get: (k: string) => string | undefined, dflt: SortSpec): SortSpec {
  const key = get("sort");
  if (!key) return dflt;
  return { key, dir: get("dir") === "asc" ? 1 : get("dir") === "desc" ? -1 : dflt.dir };
}
export function toQuery(f: SFilters, sort: SortSpec, dflt: SortSpec, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  for (const [k, v] of Object.entries(f.sel)) if (v.length) p.set(`s.${k}`, joinList(v));
  for (const [k, v] of Object.entries(f.txt)) if (v) p.set(`t.${k}`, v);
  for (const [k, v] of Object.entries(f.min)) if (v) p.set(`min.${k}`, v);
  for (const [k, v] of Object.entries(f.max)) if (v) p.set(`max.${k}`, v);
  if (sort.key !== dflt.key || sort.dir !== dflt.dir) {
    p.set("sort", sort.key);
    p.set("dir", sort.dir === 1 ? "asc" : "desc");
  }
  for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
  return p.toString();
}

/* ───── modificări imutabile ───── */
export const setSel = (f: SFilters, key: string, v: string[]): SFilters => ({ ...f, sel: withKey(f.sel, key, v.length ? v : undefined) });
export const setTxt = (f: SFilters, key: string, v: string): SFilters => ({ ...f, txt: withKey(f.txt, key, v || undefined) });
export const setRange = (f: SFilters, key: string, min: string, max: string): SFilters => ({ ...f, min: withKey(f.min, key, min || undefined), max: withKey(f.max, key, max || undefined) });
function withKey<T>(o: Record<string, T>, k: string, v: T | undefined): Record<string, T> {
  const n = { ...o };
  if (v === undefined) delete n[k];
  else n[k] = v;
  return n;
}
export const toggleSel = (f: SFilters, key: string, v: string): SFilters => {
  const cur = f.sel[key] ?? [];
  return setSel(f, key, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
};

export function activeCount(f: SFilters): number {
  return (f.q.trim() ? 1 : 0) + Object.keys(f.sel).length + Object.keys(f.txt).length + new Set([...Object.keys(f.min), ...Object.keys(f.max)]).size;
}

/** Filtrele active ca etichete (chips), cu ce trebuie schimbat ca să dispară. */
export type Chip = { id: string; label: string; clear: (f: SFilters) => SFilters };
export function describeFilters(f: SFilters, store: SourceStore | null): Chip[] {
  const chips: Chip[] = [];
  const label = (k: string) => store?.byKey.get(k)?.label ?? k;
  const join = (l: string[]) => (l.length > 3 ? `${l.slice(0, 3).join(", ")} +${l.length - 3}` : l.join(", "));
  const show = (k: string, v: string) => {
    if (v === EMPTY_TOKEN) return EMPTY_LABEL;
    const c = store?.byKey.get(k);
    return c && store ? store.label(c, v) : v;
  };
  if (f.q.trim()) chips.push({ id: "q", label: `Căutare: „${f.q.trim()}”`, clear: (x) => ({ ...x, q: "" }) });
  for (const [k, v] of Object.entries(f.sel)) chips.push({ id: `s.${k}`, label: `${label(k)}: ${join(v.map((x) => show(k, x)))}`, clear: (x) => setSel(x, k, []) });
  for (const [k, v] of Object.entries(f.txt)) chips.push({ id: `t.${k}`, label: `${label(k)} conține: „${v}”`, clear: (x) => setTxt(x, k, "") });
  const rk = [...new Set([...Object.keys(f.min), ...Object.keys(f.max)])];
  for (const k of rk) {
    const a = f.min[k] ?? "", b = f.max[k] ?? "";
    chips.push({ id: `r.${k}`, label: `${label(k)}: ${a && b ? `${a} … ${b}` : a ? `de la ${a}` : `până la ${b}`}`, clear: (x) => setRange(x, k, "", "") });
  }
  return chips;
}

/* ───── date: yyyy-mm-dd ↔ moment local ───── */
const p2 = (n: number) => String(n).padStart(2, "0");
export const dayString = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
function dayStart(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}
const num = (s: string | undefined): number => {
  if (s === undefined || s.trim() === "") return NaN;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};

/** Limitele numerice ale unui interval; pentru date `max` = sfârșitul zilei. NaN = fără limită. */
export function rangeBounds(c: ColDef, min: string | undefined, max: string | undefined): [number, number] {
  if (c.kind === "date") {
    const a = min ? dayStart(min) : NaN;
    const b = max ? dayStart(max) : NaN;
    return [a, b === b ? new Date(new Date(b).getFullYear(), new Date(b).getMonth(), new Date(b).getDate() + 1).getTime() - 1 : NaN];
  }
  return [num(min), num(max)];
}

/* ───────────────────── filtrare + sortare ───────────────────── */
export type SResult = { idx: Int32Array; matched: number };

export function runFilter(st: SourceStore, f: SFilters, sort: SortSpec): SResult {
  const order = st.order(sort);
  const n = st.n;

  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = words.length ? st.hay() : null;

  const dicts: { codes: Int32Array; ok: Uint8Array; empty: boolean }[] = [];
  for (const [k, vals] of Object.entries(f.sel)) {
    const c = st.byKey.get(k);
    if (!c || c.kind !== "dict" || !vals.length) continue;
    const names = st.dict[k];
    const want = new Set(vals);
    dicts.push({ codes: st.codes[k], ok: Uint8Array.from(names, (x) => (want.has(x) ? 1 : 0)), empty: want.has(EMPTY_TOKEN) });
  }
  const texts: { t: string[]; needle: string }[] = [];
  for (const [k, v] of Object.entries(f.txt)) {
    const c = st.byKey.get(k);
    if (!c || c.kind !== "text" || !v.trim()) continue;
    texts.push({ t: st.texts[k], needle: v.trim().toLowerCase() });
  }
  const ranges: { v: Float64Array; lo: number; hi: number }[] = [];
  for (const k of new Set([...Object.keys(f.min), ...Object.keys(f.max)])) {
    const c = st.byKey.get(k);
    if (!c || (c.kind !== "num" && c.kind !== "date")) continue;
    const [lo, hi] = rangeBounds(c, f.min[k], f.max[k]);
    if (lo !== lo && hi !== hi) continue;
    ranges.push({ v: st.nums[k], lo, hi });
  }

  if (!hay && !dicts.length && !texts.length && !ranges.length) return { idx: order, matched: n };

  const out = new Int32Array(n);
  let m = 0;
  outer: for (let p = 0; p < n; p++) {
    const i = order[p];
    for (let k = 0; k < dicts.length; k++) {
      const d = dicts[k];
      const code = d.codes[i];
      if (code < 0 ? !d.empty : d.ok[code] === 0) continue outer;
    }
    for (let k = 0; k < ranges.length; k++) {
      const r = ranges[k];
      const x = r.v[i];
      if (x !== x || (r.lo === r.lo && x < r.lo) || (r.hi === r.hi && x > r.hi)) continue outer;
    }
    for (let k = 0; k < texts.length; k++) if (!texts[k].t[i].toLowerCase().includes(texts[k].needle)) continue outer;
    if (hay) {
      const h = hay[i];
      for (let k = 0; k < words.length; k++) if (!h.includes(words[k])) continue outer;
    }
    out[m++] = i;
  }
  return { idx: out.subarray(0, m), matched: m };
}

/* ───────────────────── agregări pentru grafice ───────────────────── */

/** Numărătoare pe valorile unei coloane dict: `cnt[cod]`, iar `cnt[nume.length]` = rânduri fără valoare. `idx` null = toate rândurile. */
export function dictCounts(st: SourceStore, key: string, idx: Int32Array | null): Int32Array {
  const names = st.dict[key] ?? [];
  const cnt = new Int32Array(names.length + 1);
  const codes = st.codes[key];
  if (!codes) return cnt;
  if (idx) for (let p = 0; p < idx.length; p++) { const c = codes[idx[p]]; cnt[c < 0 ? names.length : c]++; }
  else for (let i = 0; i < st.n; i++) { const c = codes[i]; cnt[c < 0 ? names.length : c]++; }
  return cnt;
}

export type TimeAxis = { unit: "day" | "month" | "year"; n: number; start: (i: number) => number; index: (t: number) => number };
const DAY = 86_400_000;

/** Axa de timp a unei coloane date, din TOATE rândurile (zile / luni / ani, după cât de lungă e perioada). null = nicio dată. */
export function timeAxis(st: SourceStore, key: string): TimeAxis | null {
  const v = st.nums[key];
  if (!v) return null;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < v.length; i++) { const x = v[i]; if (x === x) { if (x < lo) lo = x; if (x > hi) hi = x; } }
  if (lo === Infinity) return null;
  const a = new Date(lo), b = new Date(hi);
  const days = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY) + 1;
  const unit: TimeAxis["unit"] = days <= 92 ? "day" : days <= 365 * 8 ? "month" : "year";
  const [y0, m0, d0] = [a.getFullYear(), a.getMonth(), a.getDate()];
  if (unit === "day") return { unit, n: days, start: (i) => new Date(y0, m0, d0 + i).getTime(), index: (t) => { const d = new Date(t); return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(y0, m0, d0)) / DAY); } };
  if (unit === "month") return { unit, n: (b.getFullYear() - y0) * 12 + b.getMonth() - m0 + 1, start: (i) => new Date(y0, m0 + i, 1).getTime(), index: (t) => { const d = new Date(t); return (d.getFullYear() - y0) * 12 + d.getMonth() - m0; } };
  return { unit, n: b.getFullYear() - y0 + 1, start: (i) => new Date(y0 + i, 0, 1).getTime(), index: (t) => new Date(t).getFullYear() - y0 };
}

export function timeCounts(st: SourceStore, key: string, ax: TimeAxis, idx: Int32Array | null): Int32Array {
  const v = st.nums[key];
  const out = new Int32Array(ax.n);
  const add = (i: number) => {
    const t = v[i];
    if (t !== t) return;
    const b = ax.index(t);
    if (b >= 0 && b < ax.n) out[b]++;
  };
  if (idx) for (let p = 0; p < idx.length; p++) add(idx[p]);
  else for (let i = 0; i < st.n; i++) add(i);
  return out;
}

/** Intervalul de zile (yyyy-mm-dd) al barelor [a, b] de pe o axă de timp, pentru filtrul care rezultă din click / glisare. */
export function binsToDays(ax: TimeAxis, a: number, b: number): [string, string] {
  return [dayString(ax.start(a)), dayString(ax.start(b + 1) - 1)];
}
