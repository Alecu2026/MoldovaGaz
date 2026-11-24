import fs from "node:fs";
import { Readable } from "node:stream";
import { apiGuard } from "@/lib/guard";
import { actorOf } from "@/lib/audit-actor";
import { logAudit } from "@/lib/services/audit";
import { removeReport, reportFile } from "@/lib/services/reports";

/** Descărcarea (GET) și ștergerea (DELETE) unui raport de citiri, doar pentru utilizatori autentificați. Fișierul curge direct de pe disc (poate avea sute de MB). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("reports", "export");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  const f = await reportFile(id);
  if (!f) return Response.json({ error: "Raportul nu există sau fișierul nu mai e pe disc." }, { status: 404 });
  await logAudit(actorOf(guard.user), { action: "report.download", req, objectId: id, objectName: f.name, extra: [{ label: "Dimensiune", value: `${Math.round(f.size / 1024).toLocaleString("ro-RO")} KB` }] });
  const stream = Readable.toWeb(fs.createReadStream(f.file)) as unknown as ReadableStream;
  return new Response(stream, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Length": String(f.size), "Content-Disposition": `attachment; filename="${f.name}"`, "Cache-Control": "private, no-store" } });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("reports", "delete");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  const done = await removeReport(id);
  await logAudit(actorOf(guard.user), { action: "report.delete", req, objectId: id, ok: done });
  return done ? Response.json({ ok: true }) : Response.json({ error: "Raportul nu există sau încă se generează." }, { status: 404 });
}
