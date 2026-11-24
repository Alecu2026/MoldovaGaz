import { can } from "@/lib/access";
import { apiGuard } from "@/lib/guard";
import { createAntenna, listCreatedAntennas, removeCreatedAntenna } from "@/lib/services/antennas";
import { RUN_LABEL, addModules, config, listModules, removeModule, runModule, type RunKind } from "@/lib/services/lorawan";

/**
 * Module LoRaWAN (pagina «Module LoRaWAN», pe acțiuni: vizualizare / editare + simulare / rulare / ștergere): evidența lor și rularea proceselor din SCADA asupra serverelor ChirpStack.
 *   GET    /api/lorawan                                       → { config, modules, antennas }  (cheile nu pleacă niciodată din server)
 *   POST   /api/lorawan { action: "antenna", ...câmpurile }   → creează o antenă la noi (se încarcă apoi manual în ChirpStack; nu se scrie nimic acolo)
 *   POST   /api/lorawan { action: "add", modules: [...] }      → adaugă module (cheile se păstrează criptat)
 *   POST   /api/lorawan { action: "run", id, kind, dry, confirmDelete?, cmd? }
 *   DELETE /api/lorawan?id=<devEUI>                           → scoate din evidența noastră (nu atinge ChirpStack)
 *   DELETE /api/lorawan?antenna=<EUI>                         → scoate o antenă creată la noi, dacă n-a transmis nimic încă
 */
const H = { "Cache-Control": "private, no-store" };
export async function GET() {
  const g = await apiGuard("module");
  if ("res" in g) return g.res;
  try { return Response.json({ config: config(), modules: await listModules(), antennas: await listCreatedAntennas() }, { headers: H }); }
  catch (e) { console.error("[lorawan] listă eșuată:", e); return Response.json({ error: "Nu am putut citi modulele." }, { status: 500 }); }
}

export async function POST(req: Request) {
  // Editare = adaugă module / antene și SIMULEAZĂ (doar citiri); Rulare = scrie în ChirpStack
  const g = await apiGuard("module", "edit");
  if ("res" in g) return g.res;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  if (b.action === "run" && b.dry === false && !can(g.user, "module", "run")) return Response.json({ error: "Nu ai dreptul să rulezi procese care scriu în ChirpStack." }, { status: 403 });
  try {
    if (b.action === "antenna") {
      const r = await createAntenna(b, g.user.email);
      return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r, { headers: H });
    }
    if (b.action === "add" && Array.isArray(b.modules)) return Response.json(await addModules(b.modules, g.user.email), { headers: H });
    if (b.action === "run" && typeof b.id === "string" && typeof b.kind === "string" && b.kind in RUN_LABEL) {
      const r = await runModule(b.id, b.kind as RunKind, { dry: b.dry !== false, confirmDelete: b.confirmDelete === true, cmd: typeof b.cmd === "string" ? b.cmd : undefined }, g.user.email);
      return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r, { headers: H });
    }
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  } catch (e) { console.error("[lorawan] acțiune eșuată:", e); return Response.json({ error: "Nu am putut face asta." }, { status: 500 }); }
}

export async function DELETE(req: Request) {
  const g = await apiGuard("module", "delete");
  if ("res" in g) return g.res;
  const sp = new URL(req.url).searchParams;
  const ant = sp.get("antenna");
  if (ant !== null) return Response.json({ ok: await removeCreatedAntenna(ant.toLowerCase()) }, { headers: H });
  const id = sp.get("id") ?? "";
  if (!/^[0-9a-f]{16}$/i.test(id)) return Response.json({ error: "Id invalid." }, { status: 400 });
  return Response.json({ ok: await removeModule(id) }, { headers: H });
}
