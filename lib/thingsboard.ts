/**
 * Client minimal ThingsBoard (fără importuri de Next: îl folosesc și scriptul de sincronizare, și rutele aplicației).
 * Credențialele vin DOAR din mediu: TB_USER / TB_PASS și TB_URL (obligatoriu, fără valoare implicită). Jetonul JWT se ține în memorie
 * și se reînnoiește singur (înainte de expirare sau după un 401). Folosește un cont cu drepturi de CITIRE.
 */
const g = globalThis as unknown as { __tbTok?: { token: string; exp: number; pending?: Promise<string> } };

/** Adresa SCADA vine DOAR din mediu (TB_URL), fără valoare implicită: fără ea nu pleacă nicio cerere, deci nicio extragere nu începe „din greșeală”. */
export const tbUrl = (): string => {
  const u = process.env.TB_URL?.trim();
  if (!u) throw new Error("TB_URL lipsește din mediu (ex. TB_URL=http://192.168.77.24:8080): nu pornesc nicio cerere către SCADA.");
  return u.replace(/\/$/, "");
};

function jwtExp(token: string): number {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    return (p.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

async function login(): Promise<string> {
  const user = process.env.TB_USER, pass = process.env.TB_PASS;
  if (!user || !pass) throw new Error("TB_USER / TB_PASS lipsesc din mediu.");
  // (autentificarea folosește fetch direct; calea e fixă și e în lista de apeluri permise de mai jos)
  const res = await fetch(`${tbUrl()}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: pass }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ThingsBoard login: HTTP ${res.status}`);
  const j = (await res.json()) as { token?: string };
  if (!j.token) throw new Error("ThingsBoard login: fără token");
  return j.token;
}

async function token(force = false): Promise<string> {
  const c = g.__tbTok;
  if (!force && c && c.exp - Date.now() > 120_000) return c.token;
  if (c?.pending) return c.pending;
  const pending = login().then((t) => {
    g.__tbTok = { token: t, exp: jwtExp(t) || Date.now() + 3_000_000 };
    return t;
  });
  g.__tbTok = { token: c?.token ?? "", exp: 0, pending };
  try {
    return await pending;
  } catch (e) {
    g.__tbTok = undefined;
    throw e;
  }
}

/**
 * DOAR CITIRE. Singurele apeluri permise către ThingsBoard sunt: autentificarea, interogarea de entități (POST, dar e o interogare, nu modifică nimic) și citirea
 * seriilor de timp (GET). Orice altceva — PUT / DELETE, scriere de atribute sau de telemetrie, creare / ștergere de dispozitive — e refuzat ÎNAINTE să plece
 * vreo cerere. Verificat în `npm run check`.
 */
const ALLOWED: { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/api\/auth\/login$/ },
  { method: "POST", path: /^\/api\/entitiesQuery\/find$/ },
  { method: "GET", path: /^\/api\/plugins\/telemetry\/DEVICE\/[0-9a-f-]{36}\/values\/timeseries\?[^#]*$/ },
  // lista dispozitivelor unui client (doar citire; se păstrează doar câmpurile de identificare, vezi tbCustomerDevices)
  { method: "GET", path: /^\/api\/customer\/[0-9a-f-]{36}\/devices\?pageSize=\d{1,4}&page=\d{1,4}$/ },
];
export function assertReadOnly(method: string, path: string): void {
  if (!ALLOWED.some((a) => a.method === method.toUpperCase() && a.path.test(path))) {
    throw new Error(`ThingsBoard: apel refuzat (doar citire permisă): ${method} ${path.split("?")[0]}`);
  }
}

/** Cerere către API-ul ThingsBoard, cu reîncercări la erori trecătoare (5xx / rețea) și un singur re-login la 401. */
export async function tb<T>(path: string, init?: { method?: string; body?: unknown; timeoutMs?: number; retries?: number }): Promise<T> {
  assertReadOnly(init?.method ?? "GET", path);
  const retries = init?.retries ?? 2;
  let relogged = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${tbUrl()}${path}`, {
        method: init?.method ?? "GET",
        headers: { "X-Authorization": `Bearer ${await token()}`, ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init?.timeoutMs ?? 60_000),
      });
      if (res.status === 401 && !relogged) {
        relogged = true;
        await token(true);
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) throw new Error(`HTTP ${res.status}`);
        throw Object.assign(new Error(`ThingsBoard ${path.split("?")[0]}: HTTP ${res.status}`), { status: res.status, final: true });
      }
      return (await res.json()) as T;
    } catch (e) {
      if ((e as { final?: boolean }).final || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

/** Dispozitivele unui client, pagină cu pagină (doar citire). Din fiecare dispozitiv se păstrează DOAR câmpurile de identificare: restul (deviceData, credențiale) se aruncă pe loc. */
export type TbDevice = { id: { id: string }; name: string; type: string; label: string | null; createdTime: number; customerId: { id: string } | null };
export async function tbCustomerDevices(customerId: string, opts?: { pageSize?: number; pauseMs?: number; onPage?: (page: number, pages: number, total: number) => void }): Promise<{ devices: TbDevice[]; total: number }> {
  const size = opts?.pageSize ?? 1000;
  const devices: TbDevice[] = [];
  let total = 0;
  for (let page = 0; ; page++) {
    const r = await tb<{ data: { id?: { id?: string }; name?: string; type?: string; label?: string | null; createdTime?: number; customerId?: { id?: string } | null }[]; totalPages: number; totalElements: number; hasNext: boolean }>(
      `/api/customer/${encodeURIComponent(customerId)}/devices?pageSize=${size}&page=${page}`, { timeoutMs: 120_000 });
    total = r.totalElements;
    for (const d of r.data) {
      const id = d.id?.id;
      if (!id) continue;
      devices.push({ id: { id }, name: String(d.name ?? "").trim(), type: String(d.type ?? "").trim(), label: d.label && String(d.label).trim() ? String(d.label).trim() : null, createdTime: Number(d.createdTime ?? 0), customerId: d.customerId?.id ? { id: d.customerId.id } : { id: customerId } });
    }
    opts?.onPage?.(page + 1, r.totalPages, r.totalElements);
    if (!r.hasNext) break;
    if (opts?.pauseMs) await new Promise((res) => setTimeout(res, opts.pauseMs));
  }
  return { devices, total };
}

export type TbLatest = Record<string, Record<string, { ts: number; value: string }>>;
export type TbEntity = { entityId: { id: string }; latest: TbLatest };

/** Valorile curente (serii + atribute) ale unui lot de dispozitive, într-o singură cerere. */
export async function tbLatest(ids: string[], keys: { ts: string[]; server: string[]; client: string[] }): Promise<TbEntity[]> {
  const body = {
    entityFilter: { type: "entityList", entityType: "DEVICE", entityList: ids },
    entityFields: [{ type: "ENTITY_FIELD", key: "name" }],
    latestValues: [
      ...keys.ts.map((key) => ({ type: "TIME_SERIES", key })),
      ...keys.server.map((key) => ({ type: "SERVER_ATTRIBUTE", key })),
      ...keys.client.map((key) => ({ type: "CLIENT_ATTRIBUTE", key })),
    ],
    pageLink: { pageSize: ids.length, page: 0 },
  };
  const r = await tb<{ data: TbEntity[]; hasNext: boolean }>("/api/entitiesQuery/find", { method: "POST", body, timeoutMs: 120_000 });
  if (r.hasNext) throw new Error("entitiesQuery: răspuns paginat neașteptat");
  return r.data;
}

export type TsPoint = { ts: number; value: string };
/** Serii de timp ale unui dispozitiv (valori brute, fără agregare), cele mai vechi primele. */
export async function tbSeries(deviceId: string, keys: string[], startTs: number, endTs: number, limit: number, opts?: { timeoutMs?: number; retries?: number }): Promise<Record<string, TsPoint[]>> {
  const q = new URLSearchParams({ keys: keys.join(","), startTs: String(startTs), endTs: String(endTs), limit: String(limit), agg: "NONE", orderBy: "ASC" });
  return tb<Record<string, TsPoint[]>>(`/api/plugins/telemetry/DEVICE/${encodeURIComponent(deviceId)}/values/timeseries?${q}`, { timeoutMs: opts?.timeoutMs ?? 45_000, retries: opts?.retries });
}
