import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ObjectId, type Db, type Document } from "mongodb";
import { READINGS_COLLECTION } from "./meter-readings";
import { atName, fmtLocal, headerLine, meterFilter, reportBatches, type Names, type ReportParams, type ReportRow } from "./report-readings";

/**
 * Generarea raportului de citiri (lib/report-readings.ts) într-un fișier CSV pe un loc comun, din care îl preia sistemul de facturare (Oracle).
 *  - fișierul se scrie în bucăți (nu stă în memorie) într-un `.part` și abia la sfârșit se redenumește: cine urmărește directorul vede doar fișiere COMPLETE;
 *  - lângă el se scrie `<fișier>.sha256` (suma de control), ca importul să poată verifica integritatea;
 *  - fiecare raport are o înregistrare în `billing_reports` (stare, progres, rânduri, mărime, eroare).
 * Locul comun = REPORT_OUT_DIR (director local sau montat din rețea); implicit `reports/` lângă aplicație. Un singur raport odată.
 */
export const REPORTS_COLLECTION = process.env.REPORTS_COLLECTION || "billing_reports";
export const reportDir = (): string => path.resolve(process.env.REPORT_OUT_DIR || path.join(process.cwd(), "reports"));
export const collectionNames = (): Names => ({ meters: process.env.METERS_COLLECTION || "meters", readings: READINGS_COLLECTION, history: process.env.HISTORY_COLLECTION || "meter_history" });
const STALE_MS = 6 * 3_600_000;

export type ReportResult = { id: string; file: string | null; rows: number; meters: number; bytes: number };

export const rowOf = (d: Document): ReportRow => ({
  id: String(d._id), kind: d.kind === "scheduled" ? "scheduled" : "manual", by: String(d.by ?? ""), createdAt: d.createdAt instanceof Date ? d.createdAt.getTime() : 0,
  finishedAt: d.finishedAt instanceof Date ? d.finishedAt.getTime() : null, at: Number(d.at) || Number(d.to) || 0, onlyBilled: d.onlyBilled !== false,
  status: d.status === "done" ? "done" : d.status === "error" ? "error" : "running", scanned: Number(d.scanned) || 0, total: Number(d.total) || 0, meters: Number(d.meters) || 0,
  rows: Number(d.rows) || 0, bytes: Number(d.bytes) || 0, file: typeof d.file === "string" ? d.file : null, sha256: typeof d.sha256 === "string" ? d.sha256 : null, error: typeof d.error === "string" ? d.error : null,
});

/**
 * Pornește un raport: creează înregistrarea și începe scrierea în fundal. Întoarce imediat `id`-ul și o promisiune care se încheie cu rezultatul (scriptul lunar o așteaptă;
 * serverul web o lasă să ruleze). Aruncă dacă un alt raport rulează deja.
 */
export async function startReport(db: Db, p: ReportParams, kind: "manual" | "scheduled", by: string, log: (m: string) => void = () => {}): Promise<{ id: string; done: Promise<ReportResult> }> {
  const coll = db.collection(REPORTS_COLLECTION);
  const stale = new Date(Date.now() - STALE_MS);
  await coll.updateMany({ status: "running", createdAt: { $lte: stale } }, { $set: { status: "error", error: "întrerupt (procesul s-a oprit înainte de final)", finishedAt: new Date() } });
  if (await coll.findOne({ status: "running" })) throw new Error("Un raport se generează deja. Așteaptă să se termine.");
  if (!(p.at > 0)) throw new Error("Alege data și ora raportului.");
  const names = collectionNames();
  const total = await db.collection(names.meters).countDocuments(meterFilter(p.onlyBilled));
  const _id = new ObjectId();
  await coll.insertOne({ _id, kind, by, createdAt: new Date(), at: p.at, onlyBilled: p.onlyBilled, status: "running", scanned: 0, total, meters: 0, rows: 0, bytes: 0 });
  const id = String(_id);
  const done = (async (): Promise<ReportResult> => {
    const dir = reportDir();
    const stamp = fmtLocal(Date.now()).split("-").join("").split(":").join("").split(" ").join("-");
    const name = `citiri_${atName(p.at)}_${stamp}.csv`;
    const part = path.join(dir, `${name}.part`);
    const final = path.join(dir, name);
    let out: fs.WriteStream | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      out = fs.createWriteStream(part, { encoding: "utf8" });
      const o = out;
      const write = (text: string) => new Promise<void>((resolve, reject) => { o.write(text, (err) => (err ? reject(err) : resolve())); });
      const hash = createHash("sha256");
      let bytes = 0, rows = 0, meters = 0, scanned = 0, lastSave = Date.now();
      const put = async (text: string) => { hash.update(text); bytes += Buffer.byteLength(text); await write(text); };
      await put(headerLine());
      for await (const b of reportBatches(db, p, names)) {
        if (b.text) await put(b.text);
        rows += b.rows; meters += b.meters; scanned = b.scanned;
        if (Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          await coll.updateOne({ _id }, { $set: { scanned, meters, rows, bytes } });
          log(`raport: ${scanned} / ${total} contoare, ${rows} rânduri`);
        }
      }
      await new Promise<void>((resolve, reject) => { o.end((err?: Error | null) => (err ? reject(err) : resolve())); });
      fs.renameSync(part, final);
      const sha = hash.digest("hex");
      fs.writeFileSync(`${final}.sha256`, `${sha}  ${name}\n`);
      await coll.updateOne({ _id }, { $set: { status: "done", finishedAt: new Date(), scanned: total, meters, rows, bytes, file: name, sha256: sha } });
      log(`raport gata: ${name} — ${meters} contoare, ${rows} rânduri, ${bytes} octeți`);
      return { id, file: name, rows, meters, bytes };
    } catch (e) {
      try { out?.destroy(); fs.rmSync(part, { force: true }); } catch { /* nimic de șters */ }
      await coll.updateOne({ _id }, { $set: { status: "error", finishedAt: new Date(), error: (e as Error).message.slice(0, 300) } });
      throw e;
    }
  })();
  done.catch(() => undefined); // eroarea se vede în înregistrare; apelantul o poate prinde și el
  return { id, done };
}

/** Previzualizare: primele contoare (cel mult `limit`), cu numărătorile lor și câteva rânduri de probă. Nu scrie nimic. */
export async function previewReport(db: Db, p: ReportParams, limit = 300): Promise<{ totalMeters: number; scanned: number; meters: number; rows: number; sample: string[]; header: string }> {
  const names = collectionNames();
  const totalMeters = await db.collection(names.meters).countDocuments(meterFilter(p.onlyBilled));
  let scanned = 0, meters = 0, rows = 0;
  const sample: string[] = [];
  for await (const b of reportBatches(db, p, names, { limit, batch: 100 })) {
    scanned = b.scanned; meters += b.meters; rows += b.rows;
    if (sample.length < 25) for (const line of b.text.split("\n")) { if (line && sample.length < 25) sample.push(line); }
  }
  return { totalMeters, scanned, meters, rows, sample, header: headerLine().trim() };
}
