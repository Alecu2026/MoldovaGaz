/**
 * Extrage din SCADA pozele contoarelor (atributul `image`), le micșorează și le scrie pe disc (vezi lib/photos.ts, lib/photo-job.ts). Doar CITIRE din SCADA.
 *   npm run photos:pull -- --now            → pornește acum (toate contoarele care n-au încă o stare)
 *   npm run photos:pull -- --now --limit 200  → doar primele 200 (test)
 *   npm run photos:pull -- --now --refresh  → verifică din nou și contoarele care au deja poză
 * Din pm2 (aplicația „<nume>-photos”, în fiecare zi la 22:00 și o dată la creare) pornește DOAR dacă în mediu e PHOTO_PULL=1: așa nicio extragere nu începe „din greșeală”.
 * Variabile: PHOTO_DIR (implicit `photos/`), PHOTO_MAX_PX (1000), PHOTO_CONCURRENCY (3), PHOTO_PAUSE_MS (150), PHOTO_MIN_FREE_GB (3), PHOTO_LIMIT (doar primele N).
 */
import { connectMongo } from "../lib/mongo-core";
import { pullPhotos } from "../lib/photo-job";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  const now = process.argv.includes("--now");
  if (!now && process.env.PHOTO_PULL !== "1") {
    log("extragerea pozelor e oprită (setează PHOTO_PULL=1 în .env.local, sau rulează cu --now)");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const li = process.argv.indexOf("--limit");
  const limit = li >= 0 ? Number(process.argv[li + 1]) : Number(process.env.PHOTO_LIMIT) || 0;
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop = true; log(`${sig}: termin contoarele începute și mă opresc`); });
  const client = await connectMongo(url);
  try {
    await pullPhotos(client.db(), { limit, refresh: process.argv.includes("--refresh"), log, shouldStop: () => stop });
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(`[${new Date().toISOString()}] extragerea pozelor a eșuat:`, e); process.exit(1); });
