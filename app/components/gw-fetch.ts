/**
 * Citiri GET pentru filtrul / antenele, cu memorie în browser:
 *  - același URL (aceeași antenă, același filtru) cerut din nou în `maxAgeMs` primește răspunsul de dinainte pe loc, fără rețea (comutarea între 1 km / 3 km / 10 km devine instantanee după prima dată);
 *  - cererile identice simultane se unesc într-una singură;
 *  - după expirare cererea pleacă normal, cu cache-ul HTTP al browserului: serverul întoarce ETag, deci dacă nimic nu s-a schimbat răspunsul e 304 (fără corp), iar corpul vine comprimat (gzip).
 * `null` = eroare / acces refuzat (apelantul decide ce arată).
 */
const mem = new Map<string, { at: number; v: unknown }>();
const busy = new Map<string, Promise<unknown>>();

export async function gwGet<T>(url: string, signal?: AbortSignal, maxAgeMs = 15_000): Promise<T | null> {
  const hit = mem.get(url);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.v as T;
  let p = busy.get(url) as Promise<T | null> | undefined;
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(url); // fără cache: "no-store" — browserul trimite If-None-Match și primește 304
        if (!r.ok) return null;
        const v = (await r.json()) as T;
        mem.set(url, { at: Date.now(), v });
        if (mem.size > 80) mem.delete(mem.keys().next().value as string);
        return v;
      } catch { return null; }
    })();
    busy.set(url, p);
    void p.then(() => { busy.delete(url); });
  }
  if (!signal) return p;
  if (signal.aborted) return null;
  return new Promise<T | null>((res) => { const off = () => res(null); signal.addEventListener("abort", off, { once: true }); void p.then((v) => { signal.removeEventListener("abort", off); res(v); }); });
}
