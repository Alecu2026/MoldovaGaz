import fs from "node:fs";
import { Readable } from "node:stream";
import { apiGuard } from "@/lib/guard";
import { removeReport, reportFile } from "@/lib/services/reports";

/** Descărcarea (GET) și ștergerea (DELETE) unui raport de citiri, doar pentru utilizatori autentificați. Fișierul curge direct de pe disc (poate avea sute de MB). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  const f = await reportFile(id);
  if (!f) return Response.json({ error: "Raportul nu există sau fișierul nu mai e pe disc." }, { status: 404 });
  const stream = Readable.toWeb(fs.createReadStream(f.file)) as unknown as ReadableStream;
  return new Response(stream, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Length": String(f.size), "Content-Disposition": `attachment; filename="${f.name}"`, "Cache-Control": "private, no-store" } });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  return (await removeReport(id)) ? Response.json({ ok: true }) : Response.json({ error: "Raportul nu există sau încă se generează." }, { status: 404 });
}
