/**
 * Verificarea CONTINUITĂȚII mesajelor: expeditorul pune un număr (counter) crescător pe fiecare mesaj, iar noi urmărim ce numere au venit și ce numere lipsesc.
 * Logică pură (fără baze de date), testată în `npm run check`.
 *
 *  - un „flux” = un expeditor; implicit unul singur, sau câmpul `stream` / `source` / `sender` al mesajului dacă sunt mai mulți;
 *  - numărul se caută la rădăcina mesajului (apoi în `object` sau `data`), în câmpul `msg_counter` (sau `counter`, `cnt`, `seq`, `sequence`, `message_counter`, `msg_cnt`, `counter_id`; majusculele, „_” și „-” nu contează);
 *  - un număr mai mare decât ultimul + 1 înseamnă că s-a SĂRIT peste numerele dintre ele: se notează ca „lipsă” (cu ora la care s-a observat);
 *  - un număr care sosește mai târziu și acoperă o lipsă o închide („sosit târziu”: mesajele au venit în altă ordine, nu s-au pierdut);
 *  - un număr deja primit e „duplicat” (ex. expeditorul a reîncercat după un 503): nu e pierdere;
 *  - dacă expeditorul și-a șters contorul și o ia de la capăt (numărul scade cu mai mult de RESTART_GAP față de ce se știa, sau cade sub primul număr văzut), seria
 *    se REPORNEȘTE automat; seria veche se păstrează ca rezumat în `prev` (ultimele 5).
 */
/** Numele câmpului se compară fără majuscule și fără „_” / „-”: msg_counter = msgCounter = MSG-COUNTER. */
export const COUNTER_FIELDS = ["msg_counter", "counter", "cnt", "seq", "sequence", "message_counter", "msg_cnt", "counter_id"] as const;
const FIELD_KEYS = new Set(COUNTER_FIELDS.map((f) => f.toLowerCase().replace(/[_-]/g, "")));
const STREAM_FIELDS = ["stream", "source", "sender"] as const;
export const MAX_RANGES = 1000;
/** cât de mult poate scădea un număr (față de maxim / primul văzut) ca să fie încă „sosit târziu”; mai mult = expeditorul a luat-o de la capăt */
export const RESTART_GAP = 1000;

/** [de la, până la (inclusiv), momentul în care s-a observat saltul] */
export type Gap = [number, number, number];
export type CStream = {
  id: string; field: string; first: number; max: number;
  /** numere UNICE primite (inclusiv cele sosite târziu) */
  received: number; dup: number; late: number;
  /** golurile încă deschise (cele mai vechi se șterg peste MAX_RANGES, dar rămân în `dropped`) */
  missing: Gap[]; dropped: number;
  firstAt: number; lastAt: number;
  /** seriile anterioare (oprite prin repornirea contorului expeditorului), cele mai noi ultimele */
  prev?: PrevRun[];
};
export type PrevRun = { first: number; max: number; received: number; lost: number; startedAt: number; endedAt: number };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Numărul și fluxul unui mesaj, sau null dacă mesajul nu are număr. */
export function counterOf(item: unknown): { stream: string; field: string; value: number } | null {
  if (!isObj(item)) return null;
  const places: Record<string, unknown>[] = [item];
  for (const k of ["object", "data"]) if (isObj(item[k])) places.push(item[k] as Record<string, unknown>);
  for (const p of places) {
    for (const [k, v] of Object.entries(p)) {
      if (!FIELD_KEYS.has(k.toLowerCase().replace(/[_-]/g, ""))) continue;
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v.trim()) ? Number(v) : NaN;
      if (!Number.isSafeInteger(n) || n < 0) continue;
      let stream = "implicit";
      for (const sf of STREAM_FIELDS) {
        const sv = item[sf];
        if (typeof sv === "string" && sv.trim()) { stream = sv.trim().slice(0, 80); break; }
      }
      if (stream.includes("$") || stream.includes(".")) stream = stream.replace(/[$.]/g, "_");
      return { stream, field: k, value: n };
    }
  }
  return null;
}

export function newStream(id: string, field: string, c: number, now: number): CStream {
  return { id, field, first: c, max: c, received: 1, dup: 0, late: 0, missing: [], dropped: 0, firstAt: now, lastAt: now };
}

export type Outcome = "gap" | "next" | "late" | "dup" | "restart";
/** Înregistrează numărul `c` în flux. */
export function observe(s: CStream, c: number, now: number): Outcome {
  // sub primul număr văzut: aproape de el = sosit înaintea lui (urmărirea a pornit în mijlocul seriei); departe = seria a fost repornită
  if (c < s.first) {
    if (s.first - c > RESTART_GAP) return "restart";
    s.lastAt = now;
    if (c < s.first - 1) s.missing.unshift([c + 1, s.first - 1, now]);
    s.first = c;
    s.received++;
    s.late++;
    return "late";
  }
  if (c <= s.max && s.max - c > RESTART_GAP && !s.missing.some((g) => c >= g[0] && c <= g[1])) return "restart"; // mult în urmă și nu umple niciun gol ⇒ serie nouă
  s.lastAt = now;
  if (c > s.max) {
    let out: Outcome = "next";
    if (c > s.max + 1) {
      s.missing.push([s.max + 1, c - 1, now]);
      if (s.missing.length > MAX_RANGES) {
        const old = s.missing.shift() as Gap;
        s.dropped += old[1] - old[0] + 1;
      }
      out = "gap";
    }
    s.max = c;
    s.received++;
    return out;
  }
  // c <= max: sosit târziu (acoperă un gol) sau duplicat
  for (let i = 0; i < s.missing.length; i++) {
    const [a, b, t] = s.missing[i];
    if (c < a) break; // golurile sunt în ordine crescătoare
    if (c > b) continue;
    const parts: Gap[] = [];
    if (c > a) parts.push([a, c - 1, t]);
    if (c < b) parts.push([c + 1, b, t]);
    s.missing.splice(i, 1, ...parts);
    s.received++;
    s.late++;
    return "late";
  }
  s.dup++;
  return "dup";
}

/** Rezumatul unei serii, pentru istoric. */
export const summarize = (s: CStream): PrevRun => ({ first: s.first, max: s.max, received: s.received, lost: lostOf(s), startedAt: s.firstAt, endedAt: s.lastAt });

/** Câte numere lipsesc acum (golurile deschise + cele șterse din listă). */
export const lostOf = (s: CStream): number => s.missing.reduce((a, g) => a + (g[1] - g[0] + 1), 0) + s.dropped;
