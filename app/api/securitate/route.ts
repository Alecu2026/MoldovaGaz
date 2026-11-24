import { cookies } from "next/headers";
import { actorOf } from "@/lib/audit-actor";
import { getCurrentUser } from "@/lib/dal";
import { PASSWORD_MAX } from "@/lib/password-rules";
import { SESSION_COOKIE, listSessions, revokeSessions } from "@/lib/session";
import { logAudit, recentAuthActivity } from "@/lib/services/audit";
import { changeOwnPassword } from "@/lib/services/account";

/**
 * Pagina «Securitate» (orice cont autentificat, doar pentru contul propriu; nu în simulare de login).
 *   GET  /api/securitate                                       → { sessions, activity }
 *   POST /api/securitate { action: "password", current, next } → schimbă parola (cere parola veche); celelalte sesiuni se închid
 *   POST /api/securitate { action: "revoke", id }              → închide o sesiune
 *   POST /api/securitate { action: "revoke_others" }           → închide toate sesiunile, în afară de cea curentă
 */
const H = { "Cache-Control": "private, no-store" };
async function who() {
  const user = await getCurrentUser();
  if (!user) return { res: Response.json({ error: "Autentificare necesară." }, { status: 401 }) };
  if (user.impersonation) return { res: Response.json({ error: "Indisponibil în simulare de login." }, { status: 403 }) };
  return { user, token: (await cookies()).get(SESSION_COOKIE)?.value };
}

export async function GET() {
  const w = await who();
  if ("res" in w) return w.res;
  try {
    const [sessions, activity] = await Promise.all([listSessions(w.user.id, w.token), recentAuthActivity(w.user.id, w.user.email)]);
    return Response.json({ sessions, activity, email: w.user.email }, { headers: H });
  } catch (e) {
    console.error("[securitate] citire eșuată:", e);
    return Response.json({ error: "Nu am putut citi datele." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const w = await who();
  if ("res" in w) return w.res;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    if (b?.action === "password") {
      const cur = typeof b.current === "string" ? b.current : "", next = typeof b.next === "string" ? b.next : "";
      if (!cur || !next || cur.length > PASSWORD_MAX || next.length > PASSWORD_MAX + 50) return Response.json({ error: "Completează parola veche și parola nouă." }, { status: 400 });
      const r = await changeOwnPassword(w.user, cur, next, w.token, req);
      return r.ok ? Response.json({ ok: true, closed: r.closed }, { headers: H }) : Response.json({ error: r.error }, { status: r.status });
    }
    if (b?.action === "revoke" || b?.action === "revoke_others") {
      const n = await revokeSessions(w.user.id, b.action === "revoke" ? { id: String(b.id ?? ""), keepToken: w.token } : { keepToken: w.token });
      await logAudit(actorOf(w.user), { action: "auth.sessions_revoke", req, objectName: w.user.email, extra: [{ label: "Sesiuni închise", value: String(n) }, { label: "Mod", value: b.action === "revoke" ? "una" : "toate cele din afara celei curente" }] });
      return Response.json({ ok: true, closed: n }, { headers: H });
    }
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  } catch (e) {
    console.error("[securitate] acțiune eșuată:", e);
    return Response.json({ error: "Nu am putut face asta." }, { status: 500 });
  }
}
