import { getCurrentUser } from "@/lib/dal";
import { actorOf } from "@/lib/audit-actor";
import { logAudit } from "@/lib/services/audit";
import { listFor, markSeen, publicKey, sendTest, subCount } from "@/lib/services/notifications";

/**
 * Notificările utilizatorului conectat (doar dacă are cel puțin un tip bifat la cont).
 *   GET  /api/notifications                   → { types, events, unread, seenAt, publicKey, devices }
 *   POST /api/notifications { action: "seen" } → marchează tot ca văzut;  { action: "test" } → trimite o notificare de probă pe dispozitivele lui
 */
const H = { "Cache-Control": "private, no-store" };
async function who() {
  const user = await getCurrentUser();
  if (!user) return { res: Response.json({ error: "Autentificare necesară." }, { status: 401 }) };
  if (!user.notify.length) return { res: Response.json({ error: "Contul nu primește notificări." }, { status: 403 }) };
  return { user };
}

export async function GET() {
  const w = await who();
  if ("res" in w) return w.res;
  try {
    const [list, key, devices] = await Promise.all([listFor(w.user), publicKey(), subCount(w.user.id)]);
    return Response.json({ types: w.user.notify, ...list, publicKey: key, devices }, { headers: H });
  } catch (e) {
    console.error("[notifications] citire eșuată:", e);
    return Response.json({ error: "Nu am putut citi notificările." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const w = await who();
  if ("res" in w) return w.res;
  if (w.user.impersonation) return Response.json({ error: "Indisponibil în simulare de login." }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { action?: unknown } | null;
  try {
    if (b?.action === "seen") { await markSeen(w.user.id); return Response.json({ ok: true }, { headers: H }); }
    if (b?.action === "test") { const r = await sendTest(w.user); await logAudit(actorOf(w.user), { action: "notify.test", req, extra: [{ label: "Rezultat", value: JSON.stringify(r) }] }); return Response.json(r, { headers: H }); }
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  } catch (e) {
    console.error("[notifications] acțiune eșuată:", e);
    return Response.json({ error: "Nu am putut face asta." }, { status: 500 });
  }
}
