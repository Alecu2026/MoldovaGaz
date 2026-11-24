import fs from "node:fs";
import { Readable } from "node:stream";
import { antennaIdOk } from "@/lib/antennas";
import { apiGuard } from "@/lib/guard";
import { actorOf } from "@/lib/audit-actor";
import { logAudit } from "@/lib/services/audit";
import { antennaPhotoPath, saveAntennaPhoto } from "@/lib/services/antennas";

/**
 * Poza unei antene (din SCADA sau făcută de instalator; micșorată pe server).
 *   GET  /api/antennas/<id>/photo[?size=thumb]  → JPEG (404 dacă n-are poză)
 *   POST /api/antennas/<id>/photo               → corpul = fișierul imagine (cel mult 25 MB); se micșorează și se salvează pe server, nu în SCADA
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("antennas");
  if ("res" in guard) return guard.res;
  const id = (await ctx.params).id.toLowerCase();
  if (!antennaIdOk(id)) return Response.json({ error: "Id invalid." }, { status: 400 });
  const file = antennaPhotoPath(id, new URL(req.url).searchParams.get("size") === "thumb");
  let st: fs.Stats;
  try { st = await fs.promises.stat(file); } catch { return new Response(null, { status: 404, headers: { "Cache-Control": "private, max-age=30" } }); }
  const etag = `"${st.mtimeMs.toString(36)}-${st.size}"`;
  const headers = { ETag: etag, "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache", Vary: "Cookie" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream, { headers: { ...headers, "Content-Length": String(st.size) } });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("antennas", "edit");
  if ("res" in guard) return guard.res;
  const id = (await ctx.params).id.toLowerCase();
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 26_000_000) return Response.json({ error: "Poza e prea mare (cel mult 25 MB)." }, { status: 413 });
  try {
    const bytes = Buffer.from(await req.arrayBuffer());
    const r = await saveAntennaPhoto(id, bytes, guard.user.email);
    await logAudit(actorOf(guard.user), { action: "antenna.photo", req, ok: !("error" in r), objectId: id, objectName: "error" in r ? id : r.record.name || id, extra: [{ label: "Dimensiune trimisă", value: `${Math.round(bytes.length / 1024)} KB` }, ...("error" in r ? [{ label: "Motiv", value: r.error }] : [])] });
    return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r.record, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[antennas] poză eșuată:", e);
    return Response.json({ error: "Nu am putut salva poza." }, { status: 500 });
  }
}
