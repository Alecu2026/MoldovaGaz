/**
 * Numără mesajele pe zi ale contoarelor (de câte ori a trimis fiecare contor date): compară contorul de cadre fCnt de acum cu cel reținut și adaugă diferența la zilele
 * în care s-au trimis mesajele (vezi lib/meter-msgs.ts). Citește starea contoarelor din baza noastră și scrie DOAR în colecția `meter_msgs`; nimic din SCADA.
 * Din pm2 (aplicația „<nume>-msgs”) pornește la deploy (fixează punctul de pornire imediat) și apoi la fiecare 30 de minute; mai rulează și după fiecare sincronizare.
 *   npm run msgs:count
 */
import { connectMongo } from "../lib/mongo-core";
import { appendMsgCounts } from "../lib/meter-msgs-job";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const client = await connectMongo(url);
  try {
    await appendMsgCounts(client.db(), log);
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(`[${new Date().toISOString()}] numărarea mesajelor a eșuat:`, e); process.exit(1); });
