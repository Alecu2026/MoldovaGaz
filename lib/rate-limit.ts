import "server-only";

/** Limitare simplă în memorie a încercărilor de login: MAX eșecuri într-o fereastră ⇒ blocare până expiră fereastra. */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 8;
const g = globalThis as unknown as { __loginFails?: Map<string, { n: number; first: number }> };
const fails = (g.__loginFails ??= new Map());

export function isBlocked(key: string): boolean {
  const e = fails.get(key);
  if (!e) return false;
  if (Date.now() - e.first > WINDOW_MS) {
    fails.delete(key);
    return false;
  }
  return e.n >= MAX_FAILS;
}

export function recordFail(key: string): void {
  const now = Date.now();
  const e = fails.get(key);
  if (!e || now - e.first > WINDOW_MS) fails.set(key, { n: 1, first: now });
  else e.n++;
  if (fails.size > 5000) for (const [k, v] of fails) if (now - v.first > WINDOW_MS) fails.delete(k);
}

export function clearFails(key: string): void {
  fails.delete(key);
}
