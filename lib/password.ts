import { randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";

/** Fără dependențe locale și fără `server-only`: o importă și scriptul de seed. Format: scrypt$N$r$p$salt$hash (base64). */
const N = 16384, R = 8, P = 1, KEYLEN = 64;

function derive(password: string, salt: BinaryLike, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
  return new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
