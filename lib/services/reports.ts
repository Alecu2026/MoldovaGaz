import "server-only";
import fs from "node:fs";
import path from "node:path";
import { ObjectId } from "mongodb";
import { getDb } from "../mongo";
import { REPORTS_COLLECTION, previewReport, reportDir, rowOf, startReport } from "../report-job";
import type { ReportParams, ReportRow } from "../report-readings";

/** Raportul de citiri către facturare, pentru pagina /rapoarte (vezi lib/report-job.ts). */
export const dir = (): string => reportDir();

export async function listReports(): Promise<ReportRow[]> {
  const db = await getDb();
  const docs = await db.collection(REPORTS_COLLECTION).find({}).sort({ _id: -1 }).limit(60).toArray();
  return docs.map(rowOf);
}

/** Pornește un raport în fundal (un singur raport odată) și întoarce id-ul lui. */
export async function createReport(p: ReportParams, by: string): Promise<string> {
  const db = await getDb();
  const { id } = await startReport(db, p, "manual", by, (m) => console.log(`[rapoarte] ${m}`));
  return id;
}

export async function previewNow(p: ReportParams) {
  return previewReport(await getDb(), p);
}

/** Calea fișierului unui raport terminat; doar nume de fișier simplu, din directorul raportelor. */
export async function reportFile(id: string): Promise<{ file: string; name: string; size: number } | null> {
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  const db = await getDb();
  const d = await db.collection(REPORTS_COLLECTION).findOne({ _id: new ObjectId(id) });
  const name = typeof d?.file === "string" ? d.file : "";
  if (!name || name !== path.basename(name)) return null;
  const file = path.join(dir(), name);
  try {
    return { file, name, size: fs.statSync(file).size };
  } catch {
    return null;
  }
}

/** Șterge un raport terminat sau cu eroare (înregistrarea și fișierele lui); un raport care rulează nu se șterge. */
export async function removeReport(id: string): Promise<boolean> {
  if (!/^[0-9a-f]{24}$/i.test(id)) return false;
  const db = await getDb();
  const coll = db.collection(REPORTS_COLLECTION);
  const d = await coll.findOne({ _id: new ObjectId(id) });
  if (!d || d.status === "running") return false;
  const name = typeof d.file === "string" ? d.file : "";
  if (name && name === path.basename(name)) {
    for (const f of [name, `${name}.sha256`]) fs.rmSync(path.join(dir(), f), { force: true });
  }
  await coll.deleteOne({ _id: new ObjectId(id) });
  return true;
}
