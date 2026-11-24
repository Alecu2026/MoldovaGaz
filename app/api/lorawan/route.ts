import { can } from "@/lib/access";
import { apiGuard } from "@/lib/guard";
import { actorOf } from "@/lib/audit-actor";
import { logAudit } from "@/lib/services/audit";
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
      if ("error" in r) { await logAudit(actorOf(g.user), { action: "lorawan.antenna_create", req, ok: false, objectName: String(b.name ?? ""), objectId: String(b.id ?? ""), extra: [{ label: "Motiv", value: r.error }] }); return Response.json({ error: r.error }, { status: r.status }); }
      await logAudit(actorOf(g.user), { action: "lorawan.antenna_create", req, objectId: r.antenna.id, objectName: r.antenna.name, extra: [{ label: "Descriere", value: r.antenna.description || "—" }, { label: "Locație", value: r.antenna.latitude === null ? "fără" : `${r.antenna.latitude}, ${r.antenna.longitude}` }, { label: "Altitudine", value: `${r.antenna.altitude} m` }] });
      return Response.json(r, { headers: H });
    }
    if (b.action === "add" && Array.isArray(b.modules)) {
      const r = await addModules(b.modules, g.user.email);
      const added = (r as { added?: string[] }).added ?? [], errs = (r as { errors?: { error: string }[] }).errors ?? [];
      await logAudit(actorOf(g.user), { action: "lorawan.module_add", req, ok: errs.length === 0 || added.length > 0, objectName: `${added.length} module`, extra: [{ label: "Adăugate", value: added.slice(0, 40).join(", ") || "niciunul" }, { label: "Respinse", value: errs.length ? errs.slice(0, 10).map((e) => e.error).join(" | ") : "niciunul" }, { label: "Notă", value: "Cheile nu se păstrează în jurnal." }] });
      return Response.json(r, { headers: H });
    }
    if (b.action === "run" && typeof b.id === "string" && typeof b.kind === "string" && b.kind in RUN_LABEL) {
      const r = await runModule(b.id, b.kind as RunKind, { dry: b.dry !== false, confirmDelete: b.confirmDelete === true, cmd: typeof b.cmd === "string" ? b.cmd : undefined }, g.user.email);
      const dry = b.dry !== false;
      if ("error" in r) { await logAudit(actorOf(g.user), { action: dry ? "lorawan.simulate" : "lorawan.run", req, ok: false, objectId: String(b.id).toLowerCase(), extra: [{ label: "Motiv", value: r.error }, { label: "Proces", value: String(b.kind) }] }); return Response.json({ error: r.error }, { status: r.status }); }
      await logAudit(actorOf(g.user), { action: dry ? "lorawan.simulate" : "lorawan.run", req, ok: r.outcome.ok, objectId: String(b.id).toLowerCase(), objectName: RUN_LABEL[b.kind as RunKind], extra: [{ label: "Proces", value: RUN_LABEL[b.kind as RunKind] }, { label: "Rezultat", value: r.outcome.result }, ...(r.outcome.error ? [{ label: "Eroare", value: r.outcome.error }] : []), { label: "Pași", value: r.steps.join(String.fromCharCode(10)) }, ...(b.confirmDelete === true ? [{ label: "Ștergere confirmată", value: "da (dispozitivul existent a fost șters și recreat)" }] : [])] });
      return Response.json(r, { headers: H });
    }
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  } catch (e) { console.error("[lorawan] acțiune eșuată:", e); return Response.json({ error: "Nu am putut face asta." }, { status: 500 }); }
}

export async function DELETE(req: Request) {
  const g = await apiGuard("module", "delete");
  if ("res" in g) return g.res;
  const sp = new URL(req.url).searchParams;
  const ant = sp.get("antenna");
  if (ant !== null) {
    const done = await removeCreatedAntenna(ant.toLowerCase());
    await logAudit(actorOf(g.user), { action: "lorawan.antenna_delete", req, ok: done, objectId: ant.toLowerCase() });
    return Response.json({ ok: done }, { headers: H });
  }
  const id = sp.get("id") ?? "";
  if (!/^[0-9a-f]{16}$/i.test(id)) return Response.json({ error: "Id invalid." }, { status: 400 });
  const done = await removeModule(id);
  await logAudit(actorOf(g.user), { action: "lorawan.module_delete", req, ok: done, objectId: id.toLowerCase(), extra: [{ label: "Notă", value: "Se scoate doar din evidența noastră; nu se șterge nimic din ChirpStack." }] });
  return Response.json({ ok: done }, { headers: H });
}
