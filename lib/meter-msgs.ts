/**
 * MESAJE PE ZI, pe contor (logică pură, fără baze de date; testată în `npm run check`).
 *
 * Nu se păstrează mesajele, ci CONTORUL DE CADRE al fiecărui contor (fCnt: crește cu 1 la fiecare mesaj trimis). La fiecare sincronizare (și pentru contoarele care trimit direct, la fel,
 * din starea lor curentă) se compară fCnt-ul de acum cu cel reținut data trecută: diferența = mesajele trimise între cele două momente, adăugate la ziua (UTC, ca în restul aplicației)
 * în care au fost trimise (când intervalul acoperă mai multe zile, proporțional cu timpul din fiecare zi).
 *  - fCnt mai mic decât cel reținut = contorul a repornit sesiunea (join nou): se numără mesajele de după repornire (fCnt + 1);
 *  - fără fCnt nou (același număr sau moment mai vechi) nimic nu se schimbă;
 *  - prima observare doar fixează punctul de pornire: istoria dinainte NU se poate reconstitui, deci zilele se umplu de la prima sincronizare cu această funcție.
 * Se păstrează ultimele KEEP_DAYS zile pe contor, ca vector de întregi pe 16 biți (un document de ~100 de octeți pe contor).
 */
export const DAY = 86_400_000;
export const KEEP_DAYS = 14;
export const dayIdx = (ms: number): number => Math.floor(ms / DAY);

/** f = ultimul fCnt, t = momentul lui (ms), d0 = ziua (indice UTC) a lui c[0], c = mesaje pe zi (KEEP_DAYS valori; c[KEEP_DAYS-1] = ziua ultimei actualizări), b = ziua primei observări (de când se numără) */
export type MsgState = { f: number; t: number; d0: number; c: number[]; b: number };

const MAX_COUNT = 65_535;

/** Mesajele unui contor în ziua `day` (indice de zi), sau null dacă ziua nu e în fereastra păstrată (sau contorul nu e urmărit încă). */
export function countOn(s: MsgState | undefined | null, day: number): number | null {
  if (!s) return null;
  const i = day - s.d0;
  return i >= 0 && i < s.c.length ? s.c[i] : null;
}

/** Fereastra aliniată la ziua `today` (zilele noi încep de la 0, cele ieșite din fereastră se pierd). */
function shifted(s: MsgState, today: number): MsgState {
  const d0 = today - KEEP_DAYS + 1;
  if (s.d0 === d0 && s.c.length === KEEP_DAYS) return { ...s, c: s.c.slice() };
  const c = new Array<number>(KEEP_DAYS).fill(0);
  for (let i = 0; i < s.c.length; i++) { const j = s.d0 + i - d0; if (j >= 0 && j < KEEP_DAYS) c[j] = s.c[i]; }
  return { ...s, d0, c };
}

/** `delta` mesaje trimise între `from` și `to` (ms), împărțite pe zile proporțional cu timpul din fiecare zi; ce cade în afara ferestrei se pierde. */
function spread(c: number[], d0: number, delta: number, from: number, to: number): void {
  const a = dayIdx(from), b = dayIdx(to);
  if (a >= b || to <= from) { const i = b - d0; if (i >= 0 && i < c.length) c[i] = Math.min(MAX_COUNT, c[i] + delta); return; }
  const span = to - from;
  let left = delta;
  for (let d = a; d <= b; d++) {
    const lo = Math.max(from, d * DAY), hi = Math.min(to, (d + 1) * DAY);
    const part = d === b ? left : Math.min(left, Math.round((delta * Math.max(0, hi - lo)) / span));
    left -= part;
    const i = d - d0;
    if (i >= 0 && i < c.length) c[i] = Math.min(MAX_COUNT, c[i] + part);
  }
}

/**
 * Starea nouă a unui contor după o observare (`f` = fCnt, `t` = momentul lui). Întoarce EXACT `prev` când nu se schimbă nimic (ca apelantul să nu scrie degeaba),
 * sau `null` dacă nici prima observare nu se poate face (fCnt necunoscut).
 */
export function step(prev: MsgState | null, f: number, t: number, now: number): MsgState | null {
  if (!(f >= 0) || !Number.isFinite(f)) return prev;
  const tt = !(t > 0) || t > now + 3_600_000 ? now : t; // un ceas greșit (în viitor) nu mută mesajele în zile viitoare
  const today = dayIdx(now);
  if (!prev) return { f, t: tt, d0: today - KEEP_DAYS + 1, c: new Array<number>(KEEP_DAYS).fill(0), b: dayIdx(tt) };
  if (tt <= prev.t || f === prev.f) return prev;
  const delta = f >= prev.f ? f - prev.f : f + 1;
  if (!(delta > 0) || delta > 1_000_000) return { ...shifted(prev, today), f, t: tt };
  const s = shifted(prev, today);
  spread(s.c, s.d0, delta, prev.t, tt);
  s.f = f; s.t = tt;
  return s;
}

/** Vectorul de zile ca octeți (Uint16 little-endian) pentru stocare, și înapoi. */
export function packCounts(c: number[]): Buffer {
  const b = Buffer.alloc(c.length * 2);
  for (let i = 0; i < c.length; i++) b.writeUInt16LE(Math.max(0, Math.min(MAX_COUNT, Math.round(c[i]))), i * 2);
  return b;
}
export function unpackCounts(raw: Uint8Array | { buffer: Uint8Array } | null | undefined): number[] {
  if (!raw) return [];
  const u = "buffer" in raw && !(raw instanceof Uint8Array) ? raw.buffer : (raw as Uint8Array);
  const b = Buffer.from(u.buffer, u.byteOffset, u.byteLength);
  const out = new Array<number>(Math.floor(b.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = b.readUInt16LE(i * 2);
  return out;
}

/** Ziua cerută: «azi» / «ieri» / AAAA-LL-ZZ (zi UTC), sau null dacă nu e validă. */
export function parseDay(v: string, now: number): number | null {
  const today = dayIdx(now);
  if (v === "today" || v === "") return today;
  if (v === "yesterday") return today - 1;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) && new Date(t).getUTCDate() === Number(m[3]) ? dayIdx(t) : null;
}
export const dayLabel = (d: number): string => new Date(d * DAY).toISOString().slice(0, 10);
