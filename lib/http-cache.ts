import "server-only";
import { createHash } from "node:crypto";

/**
 * Răspunsuri JSON reținute pe server, cu ETag și 304:
 *  - același răspuns (aceeași cheie = cale + filtru) se calculează O SINGURĂ DATĂ la `ttlMs`, oricâți utilizatori îl cer (cererile simultane așteaptă același calcul);
 *  - după expirare se servește imediat răspunsul vechi (cel mult `staleMs`) și se reîmprospătează în fundal, deci nimeni nu mai așteaptă recalcularea;
 *  - corpul serializat se reține împreună cu ETag-ul: când browserul trimite `If-None-Match` și nimic nu s-a schimbat, răspunsul e 304 fără corp;
 *  - compresia gzip o face serverul Next (`compress` e pornit implicit).
 * Se folosește DOAR după ce accesul a fost verificat și doar pentru răspunsuri identice pentru toți cei care trec de acea verificare (nu pentru date pe zone).
 */
type Entry = { at: number; body: string; etag: string; size: number };
const g = globalThis as unknown as { __httpCache?: { map: Map<string, Entry>; busy: Map<string, Promise<Entry | null>>; bytes: number } };
const st = (g.__httpCache ??= { map: new Map(), busy: new Map(), bytes: 0 });
const MAX_BYTES = 40_000_000;

const tag = (body: string) => `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;

function put(key: string, e: Entry) {
  const old = st.map.get(key);
  if (old) st.bytes -= old.size;
  st.map.delete(key);
  st.map.set(key, e);
  st.bytes += e.size;
  while (st.bytes > MAX_BYTES && st.map.size > 1) {
    const k = st.map.keys().next().value as string;
    st.bytes -= st.map.get(k)?.size ?? 0;
    st.map.delete(k);
  }
}

/** Calculează (o singură dată pe cheie, cererile simultane se unesc); `null` din `compute` = negăsit (nu se reține). */
function build(key: string, compute: () => Promise<unknown>): Promise<Entry | null> {
  const run = st.busy.get(key);
  if (run) return run;
  const p = (async () => {
    const data = await compute();
    if (data === null || data === undefined) { st.map.delete(key); return null; }
    const body = JSON.stringify(data);
    const e: Entry = { at: Date.now(), body, etag: tag(body), size: body.length * 2 };
    put(key, e);
    return e;
  })();
  st.busy.set(key, p);
  void p.then(() => undefined, () => undefined).then(() => { st.busy.delete(key); });
  return p;
}

export async function cachedJson(req: Request, key: string, opts: { ttlMs?: number; staleMs?: number; missing?: string }, compute: () => Promise<unknown>): Promise<Response> {
  const ttl = opts.ttlMs ?? 10_000, stale = opts.staleMs ?? 120_000;
  const now = Date.now();
  let e = st.map.get(key) ?? null;
  if (e && now - e.at < ttl) { /* proaspăt */ }
  else if (e && now - e.at < stale) { void build(key, compute).catch(() => undefined); } // se servește răspunsul vechi, se reîmprospătează în fundal
  else e = await build(key, compute);
  if (!e) return Response.json({ error: opts.missing ?? "Nu există." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  // «private, max-age=0, must-revalidate»: browserul întreabă de fiecare dată, dar primește 304 (fără corp) cât timp datele nu s-au schimbat
  const headers = { ETag: e.etag, "Cache-Control": "private, max-age=0, must-revalidate", "Content-Type": "application/json" };
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((x) => x.trim() === e.etag || x.trim() === `W/${e.etag}`)) return new Response(null, { status: 304, headers: { ETag: e.etag, "Cache-Control": headers["Cache-Control"] } });
  return new Response(e.body, { status: 200, headers });
}
