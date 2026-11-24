import { apiMeterGuard } from "@/lib/guard";
import { getRecord, saveFields } from "@/lib/services/installer";

/** Datele unui contor pentru formularul instalatorului (GET) și salvarea câmpurilor trimise (POST). Se salvează doar în baza noastră, nu în SCADA. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await apiMeterGuard("installer", id);
  if ("res" in guard) return guard.res;
  try {
    const r = await getRecord(id);
    return r ? Response.json(r, { headers: { "Cache-Control": "private, no-store" } }) : Response.json({ error: "Contorul nu există." }, { status: 404 });
  } catch (e) {
    console.error("[installer] citire eșuată:", e);
    return Response.json({ error: "Nu am putut citi contorul." }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await apiMeterGuard("installer", id);
  if ("res" in guard) return guard.res;
  const body = await req.json().catch(() => null);
  try {
    const r = await saveFields(id, body, guard.user.email);
    return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r.record, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[installer] salvare eșuată:", e);
    return Response.json({ error: "Nu am putut salva." }, { status: 500 });
  }
}
