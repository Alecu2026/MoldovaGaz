/**
 * Salvează rândurile brute din lorawandb (primul IP) și getmgdb (al doilea IP) în colecțiile `src_lorawan` și `src_billing`
 * (paginile „Dispozitive LoRaWAN” și „Facturare”). NU folosește ThingsBoard.
 *   npm run sync:sources           → citește cele două surse (doar GET) și scrie în baza de date doar rândurile schimbate
 *   npm run sync:sources -- --dry  → doar citește și arată câte rânduri sunt (nu scrie nimic)
 * Același lucru îl face și `npm run sync:meters` (la început, înainte de ThingsBoard), deci rularea separată e necesară doar pentru o încărcare rapidă.
 */
import { connectMongo } from "../lib/mongo-core";
import { fetchSources } from "../lib/meter-sync";
import { billingDocs, lorawanDocs } from "../lib/source-schemas";
import { writeSources } from "../lib/source-sync";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* fără fișier: variabilele vin din mediu */ }
  const dry = process.argv.includes("--dry");
  log("citesc lorawandb + getmgdb…");
  const { devices, billing } = await fetchSources();
  log(`  ${devices.length} dispozitive, ${billing.length} rânduri de facturare`);
  if (dry) {
    log(`DRY: ${lorawanDocs(devices).length} + ${billingDocs(billing).length} documente de scris, nimic scris`);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const client = await connectMongo(url);
  try {
    const errors = await writeSources(client.db(), devices, billing, log);
    if (errors.length) throw new Error(errors.join(" | "));
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] EROARE: ${(e as Error).message}`);
  process.exit(1);
});
