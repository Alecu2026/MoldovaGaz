/**
 * Raportul lunar de citiri către facturare (Oracle), generat AUTOMAT: pe 1 ale lunii, la 07:00 (ora serverului, cron din pm2), cu ultima citire a fiecărui contor până la acel moment
 * (1 ale lunii, ora 07:00) și doar trei câmpuri: seria radiomodulului, indicația și data reală a citirii.
 *   npm run report:monthly                 → rulează doar dacă e momentul (vezi mai jos)
 *   npm run report:monthly -- --force      → generează acum raportul pentru 1 ale lunii curente la 07:00, indiferent de dată
 * Fișierul CSV (+ `.sha256`) se scrie în REPORT_OUT_DIR (implicit `reports/`), de unde îl preia facturarea. Citește doar din baza NOASTRĂ (nimic din SCADA).
 *
 * „E momentul” = ziua 1–5 a lunii, după ora 07:00 în ziua 1, și raportul acelei luni nu există deja: așa un server oprit în ziua 1 recuperează la prima pornire,
 * iar rularea din pm2 la crearea aplicației (în orice altă zi) nu face nimic. Nu repetă un raport automat deja făcut pentru același moment.
 * Opțiuni din mediu: REPORT_ONLY_BILLED = 0 ca să includă și contoarele fără legătură cu facturarea; REPORT_HOUR = ora momentului ales (implicit 7).
 */
import { connectMongo } from "../lib/mongo-core";
import { REPORTS_COLLECTION, startReport } from "../lib/report-job";
import { atName, fmtLocal, monthStartAt } from "../lib/report-readings";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const now = Date.now();
  const local = fmtLocal(now);
  const day = Number(local.slice(8, 10)), hour = Number(local.slice(11, 13));
  const force = process.env.REPORT_FORCE === "1" || process.argv.includes("--force");
  const at = monthStartAt(now, Number(process.env.REPORT_HOUR) >= 0 && Number(process.env.REPORT_HOUR) < 24 ? Number(process.env.REPORT_HOUR) : 7);
  const name = atName(at);
  const onlyBilled = process.env.REPORT_ONLY_BILLED !== "0";

  const client = await connectMongo(url);
  try {
    const db = client.db();
    if (!force) {
      const done = await db.collection(REPORTS_COLLECTION).findOne({ kind: "scheduled", at, status: { $in: ["done", "running"] } });
      if (done) { log(`raportul automat pentru ${name} există deja (${String(done.status)}): nu îl repet`); return; }
      const due = day <= 5 && (day > 1 || hour >= 7);
      if (!due) { log(`acum e ${local}: nu e momentul (rulez pe 1 ale lunii la 07:00, sau la repornire în primele 5 zile dacă lipsește raportul pentru ${name}); folosește --force ca să-l generezi acum`); return; }
    }
    log(`generez raportul pentru ${name} (ultima citire până atunci, ${onlyBilled ? "doar contoare legate de facturare" : "toate contoarele"})`);
    const { done } = await startReport(db, { at, onlyBilled }, "scheduled", "automat", log);
    await done;
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] EROARE: ${(e as Error).message}`);
  process.exit(1);
});
