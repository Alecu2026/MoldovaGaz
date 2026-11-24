import { headers } from "next/headers";
import { requestPasswordReset } from "@/lib/services/account";

/** «Ai uitat parola?»: POST { email } → dacă adresa e a unui cont activ, primește pe e-mail un link de resetare (60 de minute, o singură dată). Răspunsul e același și când adresa nu există. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { email?: unknown } | null;
  if (typeof b?.email !== "string") return Response.json({ error: "Introdu adresa de e-mail." }, { status: 400 });
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  try {
    const r = await requestPasswordReset(b.email, ip, req);
    return r.ok ? Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } }) : Response.json({ error: r.error }, { status: r.status });
  } catch (e) {
    console.error("[parola] cerere eșuată:", e);
    return Response.json({ error: "Nu am putut procesa cererea." }, { status: 500 });
  }
}
