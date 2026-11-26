/**
 * MESAJE PE ZI, pe contor (logică pură, fără baze de date; testată în `npm run check`).
 *
 * Nu se păstrează mesajele, ci CONTORUL DE CADRE al fiecărui contor (fCnt: crește cu 1 la fiecare mesaj trimis). La fiecare sincronizare (și pentru contoarele care trimit direct, la fel,
 * din starea lor curentă) se compară fCnt-ul de acum cu cel reținut data trecută: diferența = mesajele trimise între cele două momente, adăugate la ziua (UTC, ca în restul aplicației)
 * în care au fost trimise (când intervalul acoperă mai multe zile, proporțional cu timpul din fiecare zi).
 *  - fCnt mai mic decât cel reținut = contorul a repornit sesiunea (join nou): se numără mesajele de după repornire (fCnt + 1);
 *  - fără fCnt nou (același număr sau moment mai vechi) nimic nu se schimbă;
 *  - prima observare doar fixează punctul de pornire: istoria dinainte NU se poate reconstitui, deci zilele se umplu de la prima sincronizare cu această funcție.
 * Se păstrează ultimele KEEP_DAYS zile (cât o lună întreagă + azi) pe contor, ca vector de întregi pe 16 biți (un document de ~100 de octeți pe contor).
 */
export const DAY = 86_400_000;
export const KEEP_DAYS = 31;
export const dayIdx = (ms: number): number => Math.floor(ms / DAY);

/** f = ultimul fCnt, t = momentul lui (ms), d0 = ziua (indice UTC) a lui c[0], c = mesaje pe zi (KEEP_DAYS valori; c[KEEP_DAYS-1] = ziua ultimei actualizări), b = ziua primei observări (de când se numără) */
export type MsgState = { f: number; t: number; d0: number; c: number[]; b: number };

const MAX_COUNT = 65_535;

/**
 * Mesajele unui contor în ziua `day` (indice de zi), sau null dacă ziua e înaintea ferestrei păstrate, în viitor, sau contorul nu e urmărit încă.
 * Documentul se rescrie doar când fCnt crește: zilele de după ultima lui actualizare, până azi, au 0 mesaje (contorul nu a mai trimis nimic).
 */
export function countOn(s: MsgState | undefined | null, day: number, today: number = dayIdx(Date.now())): number | null {
  if (!s || day > today) return null;
  const i = day - s.d0;
  if (i < 0) return null;
  return i < s.c.length ? s.c[i] : 0;
}

/** Perioada aleasă pentru mesaje, ca zile (indici UTC, capete incluse). */
export type Period = { from: number; to: number; multi: boolean };
/**
 * «today» · «yesterday» · AAAA-LL-ZZ (o zi) · «3d» / «7d» / «30d» (ultimele N zile ÎNTREGI, fără azi) · «r:AAAA-LL-ZZ:AAAA-LL-ZZ» (interval ales, cel mult KEEP_DAYS zile).
 * Capetele puse invers se întorc. Null = valoare invalidă.
 */
export function parsePeriod(v: string, now: number): Period | null {
  const today = dayIdx(now);
  const n = /^(\d{1,2})d$/.exec(v);
  if (n) { const k = Number(n[1]); return k >= 1 && k <= KEEP_DAYS - 1 ? { from: today - k, to: today - 1, multi: k > 1 } : null; }
  const r = /^r:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (r) {
    const a = parseDay(r[1], now), b = parseDay(r[2], now);
    if (a === null || b === null) return null;
    const from = Math.min(a, b), to = Math.max(a, b);
    return to - from + 1 > KEEP_DAYS ? { from: to - KEEP_DAYS + 1, to, multi: true } : { from, to, multi: to > from };
  }
  const d = parseDay(v, now);
  return d === null ? null : { from: d, to: d, multi: false };
}

/**
 * Mesajele unui contor pe o perioadă: total și câte zile s-au numărat. Doar zilele de la prima observare; ziua primei observări e parțială (numărătoarea a pornit în
 * timpul ei), deci într-o perioadă de mai multe zile se omite dacă mai sunt altele. Null = nimic numărat în perioadă (contor nenumărat încă).
 */
export function sumOver(s: MsgState | undefined | null, p: Period, today: number = dayIdx(Date.now())): { total: number; days: number } | null {
  if (!s) return null;
  const lo = Math.max(p.from, s.b), hi = Math.min(p.to, today);
  if (hi < lo) return null;
  const a = p.multi && hi > lo && lo === s.b ? lo + 1 : lo;
  let total = 0;
  for (let d = a; d <= hi; d++) total += countOn(s, d, today) ?? 0;
  return { total, days: hi - a + 1 };
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
