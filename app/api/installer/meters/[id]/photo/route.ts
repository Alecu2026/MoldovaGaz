import { getCurrentUser } from "@/lib/dal";
import { savePhoto } from "@/lib/services/installer";

/** Poza făcută de instalator (corpul cererii = fișierul imagine, cel mult 25 MB). Se micșorează și se salvează pe server; nu se scrie nimic în SCADA. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  const { id } = await ctx.params;
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 26_000_000) return Response.json({ error: "Poza e prea mare (cel mult 25 MB)." }, { status: 413 });
  try {
    const r = await savePhoto(id, Buffer.from(await req.arrayBuffer()), user.email);
    return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r.record, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[installer] poză eșuată:", e);
    return Response.json({ error: "Nu am putut salva poza." }, { status: 500 });
  }
}
