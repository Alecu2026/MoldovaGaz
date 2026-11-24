/**
 * Raportul lunar de citiri către facturare (Oracle), generat AUTOMAT: pe 1 ale lunii, la 07:00 (ora serverului, cron din pm2), pentru luna care tocmai s-a încheiat.
 *   npm run report:monthly                 → rulează doar dacă e momentul (vezi mai jos)
 *   npm run report:monthly -- --force      → generează acum raportul lunii precedente, indiferent de dată
 * Fișierul CSV (+ `.sha256`) se scrie în REPORT_OUT_DIR (implicit `reports/`), de unde îl preia facturarea. Citește doar din baza NOASTRĂ (nimic din SCADA).
 *
 * „E momentul” = ziua 1–5 a lunii, după ora 07:00 în ziua 1, și raportul acelei luni nu există deja: așa un server oprit în ziua 1 recuperează la prima pornire,
 * iar rularea din pm2 la crearea aplicației (în orice altă zi) nu face nimic. Nu repetă un raport automat deja făcut pentru aceeași lună.
 * Opțiuni din mediu: REPORT_MODE = all (implicit) | daily | last ; REPORT_ONLY_BILLED = 0 ca să includă și contoarele fără legătură cu facturarea.
 */
import { connectMongo } from "../lib/mongo-core";
import { REPORTS_COLLECTION, startReport } from "../lib/report-job";
import { fmtLocal, periodName, previousMonth, type ReportMode } from "../lib/report-readings";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const now = Date.now();
  const local = fmtLocal(now);
  const day = Number(local.slice(8, 10)), hour = Number(local.slice(11, 13));
  const force = process.env.REPORT_FORCE === "1" || process.argv.includes("--force");
  const range = previousMonth(now);
  const name = periodName(range.from, range.to);
  const mode: ReportMode = process.env.REPORT_MODE === "daily" ? "daily" : process.env.REPORT_MODE === "last" ? "last" : "all";
  const onlyBilled = process.env.REPORT_ONLY_BILLED !== "0";

  const client = await connectMongo(url);
  try {
    const db = client.db();
    if (!force) {
      const done = await db.collection(REPORTS_COLLECTION).findOne({ kind: "scheduled", from: range.from, to: range.to, status: { $in: ["done", "running"] } });
      if (done) { log(`raportul automat pentru ${name} există deja (${String(done.status)}): nu îl repet`); return; }
      const due = day <= 5 && (day > 1 || hour >= 7);
      if (!due) { log(`acum e ${local}: nu e momentul (rulez pe 1 ale lunii la 07:00, sau la repornire în primele 5 zile dacă lipsește raportul pentru ${name}); folosește --force ca să-l generezi acum`); return; }
    }
    log(`generez raportul pentru ${name} (${mode}, ${onlyBilled ? "doar contoare legate de facturare" : "toate contoarele"})`);
    const { done } = await startReport(db, { from: range.from, to: range.to, mode, onlyBilled }, "scheduled", "automat", log);
    await done;
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] EROARE: ${(e as Error).message}`);
  process.exit(1);
});
