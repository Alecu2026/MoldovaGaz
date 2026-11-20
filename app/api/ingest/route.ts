import { createHash, timingSafeEqual } from "node:crypto";
import { COLLECTIONS, col } from "@/lib/mongo";
import { parseUplink, type ParsedUplink } from "@/lib/uplink-parse";
import { bumpUplinkEpoch } from "@/lib/services/uplink-dataset";

/**
 * Primește mesajele (uplink-uri) de la ChirpStack / orice sistem:
 *   POST /api/ingest        Authorization: Bearer <INGEST_TOKEN>   (sau antetul X-Ingest-Token)
 * Corpul: un obiect JSON, o listă de obiecte sau NDJSON (un obiect pe linie). Formatul poate varia de la un mesaj la altul — se păstrează payload-ul întreg.
 * ChirpStack trimite la același URL și alte evenimente (join, ack, status…) cu ?event=<tip>: doar `up` (sau lipsa parametrului) se salvează; restul primesc 200 și sunt ignorate.
 * Retrimiterea aceluiași mesaj nu creează dubluri (id determinist). Răspuns: { received, inserted, duplicates, rejected: [{ index, error }] }.
 */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ITEMS = 5000;

const digest = (s: string) => createHash("sha256").update(s).digest();

function authorized(req: Request): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return false;
  const h = req.headers.get("authorization");
  const given = (h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : req.headers.get("x-ingest-token") ?? "").trim();
  return given !== "" && timingSafeEqual(digest(given), digest(expected));
}

function splitBody(text: string): { items: unknown[]; rejected: { index: number; error: string }[] } {
  const t = text.trim();
  if (!t) return { items: [], rejected: [] };
  try {
    const v = JSON.parse(t);
    return { items: Array.isArray(v) ? v : [v], rejected: [] };
  } catch {
    // NDJSON: un obiect JSON pe linie; o linie stricată nu oprește restul
  }
  const items: unknown[] = [];
  const rejected: { index: number; error: string }[] = [];
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      items.push(JSON.parse(l));
    } catch {
      rejected.push({ index: items.length + rejected.length, error: "linie JSON invalidă" });
    }
  }
  return { items, rejected };
}

export async function POST(req: Request) {
  if (!process.env.INGEST_TOKEN) return Response.json({ error: "INGEST_TOKEN nu e configurat pe server." }, { status: 503 });
  if (!authorized(req)) return Response.json({ error: "Token invalid." }, { status: 401 });
  const event = new URL(req.url).searchParams.get("event");
  if (event && event !== "up") return Response.json({ ignored: true, event });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) return Response.json({ error: "Corp prea mare." }, { status: 413 });

  const text = await req.text();
  if (text.length > MAX_BYTES) return Response.json({ error: "Corp prea mare." }, { status: 413 });
  const { items, rejected } = splitBody(text);
  if (items.length > MAX_ITEMS) return Response.json({ error: `Maxim ${MAX_ITEMS} mesaje per cerere.` }, { status: 413 });

  const received = items.length + rejected.length; // mesaje valide JSON + linii NDJSON stricate
  const receivedAt = new Date();
  const docs: ParsedUplink[] = [];
  items.forEach((it, i) => {
    const r = parseUplink(it, receivedAt);
    if ("error" in r) rejected.push({ index: i, error: r.error });
    else docs.push(r);
  });
  if (docs.length === 0) return Response.json({ received, inserted: 0, duplicates: 0, rejected }, { status: 422 });

  let inserted = 0;
  let duplicates = 0;
  try {
    const c = await col(COLLECTIONS.uplinks);
    const res = await c.insertMany(docs as never[], { ordered: false });
    inserted = res.insertedCount;
  } catch (e) {
    const err = e as { name?: string; code?: number; insertedCount?: number; writeErrors?: { code?: number } | { code?: number }[]; result?: { insertedCount?: number } };
    if (err.name !== "MongoBulkWriteError") {
      console.error("[ingest] eșuat:", e);
      return Response.json({ error: "Nu am putut salva mesajele." }, { status: 500 });
    }
    const wes = Array.isArray(err.writeErrors) ? err.writeErrors : err.writeErrors ? [err.writeErrors] : [];
    duplicates = wes.filter((w) => w.code === 11000).length;
    inserted = err.insertedCount ?? err.result?.insertedCount ?? docs.length - wes.length;
    if (wes.some((w) => w.code !== 11000)) {
      console.error("[ingest] erori la salvare:", e);
      return Response.json({ error: "Unele mesaje nu au putut fi salvate.", inserted, duplicates }, { status: 500 });
    }
  }
  if (inserted > 0) bumpUplinkEpoch();
  return Response.json({ received, inserted, duplicates, rejected });
}
