import { gunzipSync } from "node:zlib";
import { apiGuard } from "@/lib/guard";
import { encodedDatasetFor, getStore } from "@/lib/services/meter-dataset";

/**
 * Lista COMPLETĂ de contoare (coloanar) pentru motorul local din browser. ETag = `gen.seq`: aceeași versiune ⇒ 304 fără corp.
 * Se cere doar la prima deschidere (sau după repornirea serverului); în rest browserul se sincronizează cu /api/meters/delta.
 *
 * Transport: gzip-ul se face O DATĂ pe server și se memorează pe versiune. Next elimină antetele Content-Encoding / Content-Length din răspunsurile
 * route handler (și altfel și-ar comprima singur încă o dată corpul), așa că trimitem octeții ca `application/gzip` + `no-transform`, iar browserul
 * îi decomprimă cu DecompressionStream (vezi useMeterStore). Fără suport pentru el: `?enc=json` întoarce JSON simplu, pe care îl comprimă Next.
 */
export async function GET(req: Request) {
  const guard = await apiGuard("meters");
  if ("res" in guard) return guard.res;
  const user = guard.user;
  try {
    const st = await getStore();
    const { etag, gz } = encodedDatasetFor(st, user); // utilizatorul limitat primește doar contoarele din zona lui
    const plain = new URL(req.url).searchParams.get("enc") === "json";
    // private + no-cache: date interne, validate la fiecare folosire (If-None-Match → 304)
    const base = { ETag: etag, "Cache-Control": plain ? "private, no-cache" : "private, no-cache, no-transform", Vary: "Cookie" };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: base });
    const buf = await gz();
    if (plain) return new Response(new Uint8Array(gunzipSync(buf)), { headers: { ...base, "Content-Type": "application/json" } });
    return new Response(new Uint8Array(buf), { headers: { ...base, "Content-Type": "application/gzip" } });
  } catch (e) {
    console.error("[meters/dataset] eșuat:", e);
    return Response.json({ error: "Nu am putut încărca lista." }, { status: 500 });
  }
}
