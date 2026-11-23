/**
 * Pornit o singură dată când pornește serverul Next (doar în Node, nu în Edge). Pornește procesul de fundal al INTEGRĂRII: golește „cutia de intrare” cu mesajele
 * primite de la LoRaWAN / antene (lib/services/integration.ts), inclusiv ce a rămas dinainte de o repornire. Nu blochează pornirea serverului.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // „Consum nemăsurat”: lista profilurilor se încarcă acum, nu la prima cerere a unui utilizator
  const { warmNights } = await import("./lib/services/night-dataset");
  warmNights();
  if (!(process.env.INTEGRATION_TOKEN ?? "").trim()) return; // integrarea nu e activată: nimic de pornit
  const { startIntegrationWorker } = await import("./lib/services/integration");
  startIntegrationWorker();
}
