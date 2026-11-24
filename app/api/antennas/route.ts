import { apiGuard } from "@/lib/guard";
import { listAntennas } from "@/lib/services/antennas";

/** Lista antenelor pentru ecranul instalatorului de antene (vezi lib/antennas.ts): puține (câteva sute), tabelul le filtrează și sortează în browser. */
export async function GET() {
  const guard = await apiGuard("antennas");
  if ("res" in guard) return guard.res;
  try {
    return Response.json(await listAntennas(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[antennas] listă eșuată:", e);
    return Response.json({ error: "Nu am putut citi lista." }, { status: 500 });
  }
}
