import { headers } from "next/headers";
import { completePasswordReset } from "@/lib/services/account";

/** Alegerea parolei noi cu linkul din e-mail: POST { token, password }. Linkul se folosește o singură dată; după reușită toate sesiunile contului se închid. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { token?: unknown; password?: unknown } | null;
  if (typeof b?.token !== "string" || typeof b.password !== "string") return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  try {
    const r = await completePasswordReset(b.token, b.password, ip, req);
    return r.ok ? Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } }) : Response.json({ error: r.error }, { status: r.status });
  } catch (e) {
    console.error("[parola] resetare eșuată:", e);
    return Response.json({ error: "Nu am putut schimba parola." }, { status: 500 });
  }
}
