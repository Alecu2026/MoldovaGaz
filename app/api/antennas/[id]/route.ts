import { ANTENNA_SPEC, diffFields } from "@/lib/audit-diff";
import { apiGuard } from "@/lib/guard";
import { actorOf } from "@/lib/audit-actor";
import { logAudit } from "@/lib/services/audit";
import { getAntenna, saveAntenna } from "@/lib/services/antennas";

/** Datele unei antene pentru formularul „Gateway Update” (GET) și salvarea câmpurilor trimise (POST). Se salvează doar în baza noastră, nu în SCADA. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("antennas");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  try {
    const r = await getAntenna(id.toLowerCase());
    return r ? Response.json(r, { headers: { "Cache-Control": "private, no-store" } }) : Response.json({ error: "Antena nu există." }, { status: 404 });
  } catch (e) {
    console.error("[antennas] citire eșuată:", e);
    return Response.json({ error: "Nu am putut citi antena." }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("antennas", "edit");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  try {
    const key = id.toLowerCase();
    const before = await getAntenna(key).catch(() => null);
    const r = await saveAntenna(key, body, guard.user.email);
    if ("error" in r) { await logAudit(actorOf(guard.user), { action: "antenna.save", req, ok: false, objectId: key, objectName: before?.name || key, extra: [{ label: "Motiv", value: r.error }] }); return Response.json({ error: r.error }, { status: r.status }); }
    const changes = diffFields(before as unknown as Record<string, unknown> | null, r.record as unknown as Record<string, unknown>, ANTENNA_SPEC);
    if (changes.length) await logAudit(actorOf(guard.user), { action: "antenna.save", req, objectId: key, objectName: r.record.name || key, changes });
    return Response.json(r.record, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[antennas] salvare eșuată:", e);
    return Response.json({ error: "Nu am putut salva." }, { status: 500 });
  }
}
