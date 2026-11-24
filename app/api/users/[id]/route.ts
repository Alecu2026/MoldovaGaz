import { apiGuard } from "@/lib/guard";
import { deleteUser, updateUser } from "@/lib/services/users";

/** Un cont (doar administratori): PATCH = schimbă nume / parolă / drepturi / dezactivare; DELETE = șterge contul. */
const H = { "Cache-Control": "private, no-store" };

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  try {
    const r = await updateUser(id, body, guard.user.id);
    return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r.user, { headers: H });
  } catch (e) {
    console.error("[users] modificare eșuată:", e);
    return Response.json({ error: "Nu am putut salva contul." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  try {
    const r = await deleteUser(id, guard.user.id);
    return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json({ ok: true }, { headers: H });
  } catch (e) {
    console.error("[users] ștergere eșuată:", e);
    return Response.json({ error: "Nu am putut șterge contul." }, { status: 500 });
  }
}
