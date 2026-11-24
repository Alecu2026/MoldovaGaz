import path from "node:path";

/**
 * Pozele contoarelor. În SCADA fiecare contor poate avea atributul `image` = poza făcută la montaj, ca text base64 (`data:image/jpeg;base64,…`), de 1,5–3,5 MB.
 * Nu le păstrăm așa (69.000 × ~2,5 MB nu încap): le decodăm, le micșorăm (cel mult PHOTO_MAX_PX (1600) pe latura lungă, JPEG fără date EXIF — deci și fără locația din poză)
 * și le scriem ca fișiere pe disc, împreună cu o miniatură:   <PHOTO_DIR>/<primele 2 caractere ale id-ului>/<id>.jpg   și   …/<id>_t.jpg
 * În Mongo, colecția `meter_photos` ține doar starea fiecărui contor (ok / none / err), ca extragerea să poată fi oprită și reluată.
 */
export const PHOTO_COLLECTION = "meter_photos";
export const photoDir = (): string => path.resolve(process.env.PHOTO_DIR || path.join(process.cwd(), "photos"));
/** Latura lungă a pozei păstrate (PHOTO_MAX_PX, implicit 1600: se poate mări mult la zoom). Se citește la rulare, nu la import: .env.local se încarcă abia în script. */
export const fullPx = (): number => Math.max(400, Math.min(3000, Number(process.env.PHOTO_MAX_PX) || 1600));
export const THUMB_PX = 240;

/** id-ul unui contor = id-ul dispozitivului din SCADA (UUID). Verificat strict: ajunge într-o cale de fișier. */
export const validId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

export function photoPath(id: string, thumb = false, dir: string = photoDir()): string {
  if (!validId(id)) throw new Error("id de contor invalid");
  return path.join(dir, id.slice(0, 2), `${id}${thumb ? "_t" : ""}.jpg`);
}

/** Textul din atribut → octeții imaginii (JPEG / PNG / WebP), sau null dacă nu e o imagine validă. */
export function decodeImage(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length < 2000) return null;
  const m = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(value);
  const b64 = m ? value.slice(m[0].length) : value;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64.slice(0, 200))) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 1000) return null;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return jpeg || png || webp ? buf : null;
}

export type Processed = { full: Buffer; thumb: Buffer; w: number; h: number };

/** Micșorează (respectând orientarea din EXIF), scoate metadatele, scrie JPEG. `sharp` se încarcă doar aici, ca restul aplicației să nu-l ceară. */
export async function processImage(buf: Buffer, maxPx: number = fullPx()): Promise<Processed> {
  const sharp = (await import("sharp")).default;
  sharp.concurrency(2);
  const base = () => sharp(buf, { failOn: "none", limitInputPixels: 300_000_000 }).rotate();
  const full = await base().resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const thumb = await sharp(full.data).resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70, mozjpeg: true }).toBuffer();
  return { full: full.data, thumb, w: full.info.width, h: full.info.height };
}
