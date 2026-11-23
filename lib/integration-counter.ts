/**
 * Verificarea CONTINUITĂȚII mesajelor: expeditorul pune un număr (counter) crescător pe fiecare mesaj, iar noi urmărim ce numere au venit și ce numere lipsesc.
 * Logică pură (fără baze de date), testată în `npm run check`.
 *
 *  - un „flux” = un expeditor; implicit unul singur, sau câmpul `stream` / `source` / `sender` al mesajului dacă sunt mai mulți;
 *  - numărul se caută la rădăcina mesajului, în câmpul `counter` (sau `cnt`, `seq`, `sequence`, `msgCounter`, `messageCounter`, `msgCnt`, `counterId`);
 *  - un număr mai mare decât ultimul + 1 înseamnă că s-a SĂRIT peste numerele dintre ele: se notează ca „lipsă” (cu ora la care s-a observat);
 *  - un număr care sosește mai târziu și acoperă o lipsă o închide („sosit târziu”: mesajele au venit în altă ordine, nu s-au pierdut);
 *  - un număr deja primit e „duplicat” (ex. expeditorul a reîncercat după un 503): nu e pierdere.
 */
export const COUNTER_FIELDS = ["counter", "cnt", "seq", "sequence", "msgCounter", "messageCounter", "msgCnt", "counterId"] as const;
const STREAM_FIELDS = ["stream", "source", "sender"] as const;
export const MAX_RANGES = 1000;

/** [de la, până la (inclusiv), momentul în care s-a observat saltul] */
export type Gap = [number, number, number];
export type CStream = {
  id: string; field: string; first: number; max: number;
  /** numere UNICE primite (inclusiv cele sosite târziu) */
  received: number; dup: number; late: number;
  /** golurile încă deschise (cele mai vechi se șterg peste MAX_RANGES, dar rămân în `dropped`) */
  missing: Gap[]; dropped: number;
  firstAt: number; lastAt: number;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Numărul și fluxul unui mesaj, sau null dacă mesajul nu are număr. */
export function counterOf(item: unknown): { stream: string; field: string; value: number } | null {
  if (!isObj(item)) return null;
  for (const f of COUNTER_FIELDS) {
    const v = item[f];
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) continue;
    let stream = "implicit";
    for (const sf of STREAM_FIELDS) {
      const sv = item[sf];
      if (typeof sv === "string" && sv.trim()) { stream = sv.trim().slice(0, 80); break; }
    }
    if (stream.includes("$") || stream.includes(".")) stream = stream.replace(/[$.]/g, "_");
    return { stream, field: f, value: n };
  }
  return null;
}

export function newStream(id: string, field: string, c: number, now: number): CStream {
  return { id, field, first: c, max: c, received: 1, dup: 0, late: 0, missing: [], dropped: 0, firstAt: now, lastAt: now };
}

export type Outcome = "gap" | "next" | "late" | "dup";
/** Înregistrează numărul `c` în flux. */
export function observe(s: CStream, c: number, now: number): Outcome {
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

/** Câte numere lipsesc acum (golurile deschise + cele șterse din listă). */
export const lostOf = (s: CStream): number => s.missing.reduce((a, g) => a + (g[1] - g[0] + 1), 0) + s.dropped;
