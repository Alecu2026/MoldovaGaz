import { gunzipSync } from "node:zlib";
import { getCurrentUser } from "@/lib/dal";
import { encodedDataset, getStore } from "@/lib/services/uplink-dataset";

/**
 * Lista COMPLETĂ (coloanar) pentru motorul local din browser. ETag = `gen.head`: aceeași versiune ⇒ 304 fără corp.
 * Se cere doar la prima deschidere (sau după repornirea serverului); în rest browserul se sincronizează cu /api/uplinks/delta.
 *
 * Transport: gzip-ul e făcut O DATĂ pe server și memorat pe versiune. Next elimină antetele Content-Encoding / Content-Length din răspunsurile
 * route handler (și altfel și-ar comprima singur încă o dată corpul), așa că trimitem octeții ca `application/gzip` + `no-transform`, iar browserul
 * îi decomprimă cu DecompressionStream (vezi useUplinkStore). Fără suport pentru el: `?enc=json` întoarce JSON simplu, pe care îl comprimă Next.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  try {
    const st = await getStore();
    const { etag, gz } = encodedDataset(st);
    const plain = new URL(req.url).searchParams.get("enc") === "json";
    // private + no-cache: date interne, validate la fiecare folosire (If-None-Match → 304)
    const base = { ETag: etag, "Cache-Control": plain ? "private, no-cache" : "private, no-cache, no-transform", Vary: "Cookie" };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: base });
    const buf = await gz;
    if (plain) return new Response(new Uint8Array(gunzipSync(buf)), { headers: { ...base, "Content-Type": "application/json" } });
    return new Response(new Uint8Array(buf), { headers: { ...base, "Content-Type": "application/gzip" } });
  } catch (e) {
    console.error("[uplinks/dataset] eșuat:", e);
    return Response.json({ error: "Nu am putut încărca lista." }, { status: 500 });
  }
}
