import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_BODY_BYTES } from "@/lib/integration";
import { BusyError, accept, startIntegrationWorker } from "@/lib/services/integration";

/**
 * INTEGRARE — `POST /api/integration`: primește date direct de la rețeaua LoRaWAN / antene. Orice a trimis expeditorul se SALVEAZĂ durabil și se răspunde 200:
 * mesajele în forma documentului unui contor ({ id?, tb: { name, … }, bill?, attrs?, tel: { <cheie>: { t, v } } }) se aplică pe contoare în câteva secunde;
 * orice altceva (alt format, contor necunoscut, text care nu e JSON) se PĂSTREAZĂ pentru procesare ulterioară (colecția `integration_raw`, cu motivul) și NU dă eroare.
 * Autentificare: `Authorization: Bearer <INTEGRATION_TOKEN>` (sau antetul `X-Integration-Token`). Corpul poate fi comprimat (`Content-Encoding: gzip`), maximum 8 MB.
 *
 * GARANȚIE: 200 = datele sunt salvate DURABIL. Dacă nu s-au putut salva (503 / eroare / fără răspuns), expeditorul REÎNCEARCĂ: aplicarea e idempotentă.
 * Răspunsuri: 200 {received, accepted, kept} · 401 token lipsă / greșit (cu motivul) · 413 mai mare de 8 MB · 503 ocupat / dezactivat (cu Retry-After).
 * Nu există blocare pe adresă: un token corect trece oricând.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Verifică tokenul. Dacă nu e corect, spune CE e greșit (fără să dezvăluie tokenul), ca expeditorul să-și poată repara cererea. */
function check(req: Request, token: string): { ok: true } | { ok: false; why: string } {
  const h = req.headers.get("authorization");
  const x = req.headers.get("x-integration-token");
  if (!h && !x) return { ok: false, why: "lipsește antetul Authorization (se așteaptă: Authorization: Bearer <token>)" };
  const given = (h ? (/^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : "") : x ?? "").trim().replace(/^"(.*)"$/, "$1");
  if (!given) return { ok: false, why: 'antetul Authorization nu are forma "Bearer <token>"' };
  if (given.length !== token.length) return { ok: false, why: `tokenul are ${given.length} caractere, iar cel așteptat ${token.length}: verifică dacă a fost copiat întreg, fără spații sau ghilimele` };
  return timingSafeEqual(digest(given), digest(token)) ? { ok: true } : { ok: false, why: "tokenul nu e cel corect" };
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
  const auth = check(req, token);
  if (!auth.ok) return json({ error: "Token invalid.", reason: auth.why }, 401);
  startIntegrationWorker(); // sigur de apelat din nou: pornește procesul doar o dată

  let text: string | "too-large";
  try {
    text = await readBody(req);
  } catch {
    text = ""; // gzip stricat: nu e o eroare a expeditorului pe care s-o refuzăm; păstrăm ce avem (nimic) și răspundem normal
  }
  if (text === "too-large") return json({ error: "Cererea e prea mare (maximum 8 MB).", maxBytes: MAX_BODY_BYTES }, 413);

  // orice conținut: JSON (obiect sau listă) sau text oarecare, care se păstrează ca atare
  let items: unknown[];
  try {
    const data: unknown = JSON.parse(text);
    items = Array.isArray(data) ? data : [data];
  } catch {
    items = text.trim() === "" ? [] : [{ __raw: text }];
  }
  if (items.length === 0) return json({ received: 0, accepted: 0, kept: 0 });

  try {
    return json(await accept(items));
  } catch (e) {
    if (e instanceof BusyError) return json({ error: "Server ocupat: reîncearcă.", retryAfter: e.retryAfter }, 503, { "Retry-After": String(e.retryAfter) });
    console.error("[integration] salvarea a eșuat:", (e as Error).message);
    return json({ error: "Nu am putut salva datele: reîncearcă." }, 503, { "Retry-After": "2" });
  }
}
