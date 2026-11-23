import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_BATCH, MAX_BODY_BYTES } from "@/lib/integration";
import { isBlocked, recordFail } from "@/lib/rate-limit";
import { BusyError, accept, startIntegrationWorker } from "@/lib/services/integration";

/**
 * INTEGRARE — `POST /api/integration`: primește mesaje de contor direct de la rețeaua LoRaWAN / antene (un obiect sau o listă, cel mult 1000), în forma documentului
 * unui contor: { id?, tb: { name, type, … }, bill?, attrs?, tel: { <cheie>: { t, v } } }. Autentificare: `Authorization: Bearer <INTEGRATION_TOKEN>` (sau antetul
 * `X-Integration-Token`). Corpul poate fi trimis comprimat (`Content-Encoding: gzip`).
 *
 * GARANȚIE: un răspuns 200 înseamnă că mesajele sunt salvate DURABIL (cutia de intrare, cu jurnal) și vor fi aplicate pe contoare în cel mult câteva secunde. Dacă nu
 * s-a putut salva (503 / 5xx / fără răspuns), expeditorul trebuie să REÎNCERCE: aplicarea e idempotentă, deci reîncercarea nu strică nimic. Dacă serverul e supraîncărcat,
 * răspunde 503 cu `Retry-After` (nu pierde mesaje și nu le acceptă pe jumătate).
 * Răspunsuri: 200 {received, accepted, errors[]} · 400 JSON invalid · 401 token · 413 prea mare · 422 niciun mesaj valid · 429 prea multe încercări greșite · 503 ocupat / dezactivat.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const clientKey = (req: Request) => `integration:${(req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "local").split(",")[0].trim()}`;
const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

function authorized(req: Request, token: string): boolean {
  const h = req.headers.get("authorization");
  const given = (h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : req.headers.get("x-integration-token") ?? "").trim();
  return given.length > 0 && timingSafeEqual(digest(given), digest(token));
}

/** Citește corpul cu limită de dimensiune (și după decomprimare, ca să nu fie „bombă” gzip). */
async function readBody(req: Request): Promise<string | "too-large"> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "too-large";
  if (!req.body) return "";
  const gz = (req.headers.get("content-encoding") ?? "").toLowerCase().includes("gzip");
  const stream = gz ? req.body.pipeThrough(new DecompressionStream("gzip")) : req.body;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: Request) {
  const token = (process.env.INTEGRATION_TOKEN ?? "").trim();
  if (token.length < 24) return json({ error: "Integrarea nu e activată (INTEGRATION_TOKEN lipsește sau e prea scurt: minimum 24 de caractere)." }, 503);
  const key = clientKey(req);
  if (isBlocked(key)) return json({ error: "Prea multe încercări greșite. Reîncearcă mai târziu." }, 429, { "Retry-After": "900" });
  if (!authorized(req, token)) {
    recordFail(key);
    return json({ error: "Token invalid." }, 401);
  }
  startIntegrationWorker(); // sigur de apelat din nou: pornește procesul doar o dată

  let text: string | "too-large";
  try {
    text = await readBody(req);
  } catch {
    return json({ error: "Corp invalid (gzip stricat?)." }, 400);
  }
  if (text === "too-large") return json({ error: "Cererea e prea mare (maximum 8 MB).", maxBytes: MAX_BODY_BYTES }, 413);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "JSON invalid." }, 400);
  }
  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) return json({ received: 0, accepted: 0, errors: [] });
  if (items.length > MAX_BATCH) return json({ error: `Prea multe mesaje într-o cerere (maximum ${MAX_BATCH}).`, max: MAX_BATCH }, 413);

  try {
    const r = await accept(items);
    return json(r, r.accepted === 0 && r.errors.length > 0 ? 422 : 200);
  } catch (e) {
    if (e instanceof BusyError) return json({ error: "Server ocupat: reîncearcă.", retryAfter: e.retryAfter }, 503, { "Retry-After": String(e.retryAfter) });
    console.error("[integration] salvarea în cutia de intrare a eșuat:", (e as Error).message);
    return json({ error: "Nu am putut salva mesajele: reîncearcă." }, 503, { "Retry-After": "2" });
  }
}
