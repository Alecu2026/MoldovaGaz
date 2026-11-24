import { apiGuard } from "@/lib/guard";
import { listEdits } from "@/lib/services/installer";

/** Ce au introdus instalatorii la noi (Instalation_Litres, ContorNr), pentru contoarele din zona utilizatorului: suprascrie valorile din SCADA în tabel. */
export async function GET() {
  const guard = await apiGuard("installer");
  if ("res" in guard) return guard.res;
  try {
    return Response.json({ edits: await listEdits(guard.user) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[installer/edits] eșuat:", e);
    return Response.json({ error: "Nu am putut citi datele." }, { status: 500 });
  }
}
