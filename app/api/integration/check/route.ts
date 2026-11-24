import { apiGuard } from "@/lib/guard";
import { checkMessage } from "@/lib/services/integration";

/** Verifică un mesaj FĂRĂ să-l salveze (doar utilizatori autentificați): îl validează și arată rezumatul derivat. Pentru a depana ce trimite expeditorul. */
export async function POST(req: Request) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 1_000_000) return Response.json({ ok: false, error: "Mesaj prea mare." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ ok: false, error: "JSON invalid." }, { status: 400 });
  }
  try {
    return Response.json(await checkMessage(Array.isArray(body) ? body[0] : body), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/check] eșuat:", e);
    return Response.json({ ok: false, error: "Nu am putut verifica mesajul." }, { status: 500 });
  }
}
