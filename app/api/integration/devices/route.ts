import { getCurrentUser } from "@/lib/dal";
import { integrationDevices } from "@/lib/services/integration";

/** „De la care contoare ia date”: contoarele care au trimis prin integrare + ce s-a păstrat, cu contorul cu care se potrivește. Doar utilizatori autentificați. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  try {
    return Response.json(await integrationDevices(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/devices] eșuat:", e);
    return Response.json({ error: "Nu am putut citi lista." }, { status: 500 });
  }
}
