/**
 * Salvează rândurile brute din getmgdb (facturarea) în colecția `src_billing` (pagina „Facturare”). NU folosește SCADA.
 *   npm run sync:sources                  → citește getmgdb (doar GET) și scrie în baza de date doar rândurile schimbate
 *   npm run sync:sources -- --dry         → doar citește și numără, nu scrie nimic
 *   npm run sync:sources -- --drop-lorawan → șterge colecția veche `src_lorawan` (pagina /lorawan a fost scoasă); nu citește nimic din rețea
 * Același lucru îl face și `npm run sync:meters` (la început, înainte de SCADA), deci rularea separată e necesară doar pentru o încărcare rapidă.
 */
import { connectMongo } from "../lib/mongo-core";
import { fetchBilling } from "../lib/meter-sync";
import { billingDocs } from "../lib/source-schemas";
import { dropLegacyLorawan, writeSources } from "../lib/source-sync";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* fără fișier: variabilele vin din mediu */ }
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const url = process.env.DATABASE_URL;

  if (args.includes("--drop-lorawan")) {
    if (!url) throw new Error("DATABASE_URL lipsește.");
    const client = await connectMongo(url);
    try {
      const n = await dropLegacyLorawan(client.db());
      log(n > 0 ? `colecția veche src_lorawan ștearsă (avea ${n} documente)` : "colecția src_lorawan nu există: nimic de șters");
    } finally {
      await client.close();
    }
    return;
  }

  log("citesc getmgdb…");
  const billing = await fetchBilling();
  log(`  ${billing.length} rânduri de facturare`);
  if (dry) {
    log(`DRY: ${billingDocs(billing).length} documente de scris, nimic scris`);
    return;
  }
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const client = await connectMongo(url);
  try {
    const errors = await writeSources(client.db(), billing, log);
    if (errors.length) throw new Error(errors.join(" | "));
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] EROARE: ${(e as Error).message}`);
  process.exit(1);
});
