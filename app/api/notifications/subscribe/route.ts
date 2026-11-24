import { getCurrentUser } from "@/lib/dal";
import { cleanSub } from "@/lib/push";
import { removeSub, saveSub } from "@/lib/services/notifications";

/** Abonamentul push al unui dispozitiv (browser / telefon) al utilizatorului: POST { subscription } îl salvează, DELETE { endpoint } îl scoate. */
const H = { "Cache-Control": "private, no-store" };
async function who() {
  const user = await getCurrentUser();
  if (!user) return { res: Response.json({ error: "Autentificare necesară." }, { status: 401 }) };
  if (!user.notify.length) return { res: Response.json({ error: "Contul nu primește notificări." }, { status: 403 }) };
  return { user };
}

export async function POST(req: Request) {
  const w = await who();
  if ("res" in w) return w.res;
  const b = (await req.json().catch(() => null)) as { subscription?: unknown } | null;
  const sub = cleanSub(b?.subscription);
  if (!sub) return Response.json({ error: "Abonament invalid." }, { status: 400 });
  await saveSub(w.user.id, sub, req.headers.get("user-agent") ?? "");
  return Response.json({ ok: true }, { headers: H });
}

export async function DELETE(req: Request) {
  const w = await who();
  if ("res" in w) return w.res;
  const b = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof b?.endpoint !== "string") return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  await removeSub(w.user.id, b.endpoint);
  return Response.json({ ok: true }, { headers: H });
}
