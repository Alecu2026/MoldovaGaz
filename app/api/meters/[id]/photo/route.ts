import fs from "node:fs";
import { Readable } from "node:stream";
import { getCurrentUser } from "@/lib/dal";
import { photoPath, validId } from "@/lib/photos";
import { installerPhotoPath } from "@/lib/services/installer";

/**
 * Poza unui contor (extrasă din SCADA și micșorată, vezi lib/photos.ts), doar pentru utilizatori autentificați.
 *   GET /api/meters/<id>/photo           → poza (JPEG, cel mult PHOTO_MAX_PX pe latura lungă)
 *   GET /api/meters/<id>/photo?size=thumb → miniatura (240 px)
 * Poza făcută de instalator (ecranul /instalator) are prioritate față de cea din SCADA.
 * 404 dacă contorul n-are poză (sau încă n-a fost extrasă).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  const { id } = await ctx.params;
  if (!validId(id)) return Response.json({ error: "Id invalid." }, { status: 400 });
  const thumb = new URL(req.url).searchParams.get("size") === "thumb";
  // poza făcută de instalator (ecranul /instalator) are prioritate față de cea extrasă din SCADA
  let file = installerPhotoPath(id, thumb);
  let st: fs.Stats;
  try { st = await fs.promises.stat(file); } catch {
    file = photoPath(id, thumb);
    try { st = await fs.promises.stat(file); } catch { return new Response(null, { status: 404, headers: { "Cache-Control": "private, max-age=60" } }); }
  }
  const etag = `"${st.mtimeMs.toString(36)}-${st.size}"`;
  const headers = { ETag: etag, "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache", Vary: "Cookie" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream, { headers: { ...headers, "Content-Length": String(st.size) } });
}
