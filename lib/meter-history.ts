/**
 * Istoricul Volume (m³) al unui contor, împachetat compact pentru stocare: două vectori binari — momentele (secunde, Int32 little-endian) și valorile (Float64) —
 * în loc de o listă de perechi (≈12 octeți / punct în loc de ≈40). Aceleași funcții le folosesc scriptul de descărcare (PC), cel de încărcare (server) și ruta API.
 * Fără importuri de Next / Mongo: se rulează și din scripturi.
 */
export type Pts = [number, number][];
/** Forma din fișierele JSONL: vectorii ca base64. */
export type PackedB64 = { n: number; t: string; v: string };
type Bytes = Uint8Array | { buffer: Uint8Array };

export function pack(points: Pts): PackedB64 {
  const n = points.length;
  const t = Buffer.alloc(n * 4);
  const v = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) {
    t.writeInt32LE(Math.round(points[i][0] / 1000), i * 4);
    v.writeDoubleLE(points[i][1], i * 8);
  }
  return { n, t: t.toString("base64"), v: v.toString("base64") };
}

const raw = (b: string | Bytes): Buffer => {
  if (typeof b === "string") return Buffer.from(b, "base64");
  const u = "buffer" in b && !(b instanceof Uint8Array) ? b.buffer : (b as Uint8Array);
  return Buffer.from(u.buffer, u.byteOffset, u.byteLength);
};

export function unpack(p: { n: number; t: string | Bytes; v: string | Bytes }): Pts {
  const t = raw(p.t), v = raw(p.v);
  const n = Math.min(p.n, Math.floor(t.length / 4), Math.floor(v.length / 8));
  const out: Pts = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [t.readInt32LE(i * 4) * 1000, v.readDoubleLE(i * 8)];
  return out;
}

/** O linie din fișierul JSONL: un contor cu istoricul lui. `h` = Volume_m3_Total_ts (orar), `x` = Volume_m3_Total (la transmisie). */
export type HistoryLine = { _id: string; from: number; to: number; fetchedAt: number; h: PackedB64; x: PackedB64 };
