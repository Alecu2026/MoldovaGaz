import { gunzipSync } from "node:zlib";
import { apiGuard } from "@/lib/guard";
import { getSource } from "@/lib/services/source-dataset";
import { isSourceId } from "@/lib/source-shared";

/**
 * Lista COMPLETĂ a unei surse (lorawan = lorawandb, billing = getmgdb), coloanar, pentru motorul local din browser.
 * Același transport ca /api/meters/dataset: gzip făcut o dată pe server (application/gzip + no-transform, decomprimat în browser cu DecompressionStream),
 * ETag = amprenta datelor din baza de date ⇒ 304 fără corp când nu s-a schimbat nimic; `?enc=json` = JSON simplu pentru browsere fără DecompressionStream.
 */
export async function GET(req: Request, ctx: { params: Promise<{ source: string }> }) {
  const { source } = await ctx.params;
  if (!isSourceId(source)) return Response.json({ error: "Sursă necunoscută." }, { status: 404 });
  const guard = await apiGuard(source === "billing" ? "billing" : "lorawan"); // pagina «Facturare» / «Dispozitive LoRaWAN»
  if ("res" in guard) return guard.res;
  try {
    const b = await getSource(source);
    const plain = new URL(req.url).searchParams.get("enc") === "json";
    const base = { ETag: b.etag, "Cache-Control": plain ? "private, no-cache" : "private, no-cache, no-transform", Vary: "Cookie" };
    if (req.headers.get("if-none-match") === b.etag) return new Response(null, { status: 304, headers: base });
    const buf = await b.gz;
    if (plain) return new Response(new Uint8Array(gunzipSync(buf)), { headers: { ...base, "Content-Type": "application/json" } });
    return new Response(new Uint8Array(buf), { headers: { ...base, "Content-Type": "application/gzip" } });
  } catch (e) {
    console.error(`[sources/${source}] eșuat:`, e);
    return Response.json({ error: "Nu am putut încărca lista." }, { status: 500 });
  }
}
