import { getCurrentUser } from "@/lib/dal";
import { clampParams, suspects } from "@/lib/services/night-dataset";

/**
 * „Consum nemăsurat”: contoarele cu nopți suspecte, după parametrii din URL (from, to = intervalul nopții în ore, nights, maxNight, minDay, minTemp, tempMode, minNights; vezi lib/night-analysis.ts).
 * Lucrează doar din baza noastră (colecția meter_nights), fără SCADA; răspunsul e instant după prima încărcare în memorie.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  const q = new URL(req.url).searchParams;
  try {
    const p = clampParams({ startHour: q.get("from"), endHour: q.get("to"), nights: q.get("nights"), maxNight: q.get("maxNight"), minDay: q.get("minDay"), minTemp: q.get("minTemp"), tempMode: q.get("tempMode"), minNights: q.get("minNights") });
    return Response.json(await suspects(p), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[control/suspects] eșuat:", e);
    return Response.json({ error: "Nu am putut calcula lista." }, { status: 500 });
  }
}
