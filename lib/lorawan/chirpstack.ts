/**
 * Clientul REST ChirpStack, cu aceleași apeluri ca lanțul din SCADA.
 *  · v3: autentificare cu cont (POST /api/internal/login → jwt), antet «Grpc-Metadata-Authorization: Bearer <jwt>»; câmpurile în camelCase cu «ID» (applicationID, deviceProfileID, devEUI);
 *  · v4 (proxy REST): token dat direct, câmpuri «applicationId», «deviceProfileId», «devEui».
 * Nu aruncă la erori HTTP: întoarce { ok, status, body } (status 0 = fără răspuns). La 401 se reautentifică o singură dată. `fetchFn` se poate înlocui (teste).
 */
export type Res = { ok: boolean; status: number; body: unknown };
export type FetchFn = typeof fetch;
export type Creds = { email: string; password: string };
export type Quote = { applicationID: string; deviceProfileID: string };

export class ChirpStack {
  private jwt: string | null;
  constructor(readonly base: string, readonly version: 3 | 4, private auth: { creds?: Creds; token?: string }, private fetchFn: FetchFn = fetch, private timeoutMs = 15_000) {
    this.jwt = auth.token ?? null;
  }
  private async raw(method: string, path: string, body?: unknown, withAuth = true): Promise<Res> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchFn(this.base.replace(/\/+$/, "") + path, {
        method, signal: ctl.signal,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(withAuth && this.jwt ? { "Grpc-Metadata-Authorization": `Bearer ${this.jwt}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* răspuns ne-JSON */ }
      return { ok: r.ok, status: r.status, body: parsed };
    } catch (e) {
      return { ok: false, status: 0, body: { error: (e as Error).message } };
    } finally { clearTimeout(t); }
  }
  /** v3: login cu cont. v4: nu e nevoie (token). */
  async login(): Promise<Res> {
    if (this.version === 4) return { ok: !!this.jwt, status: this.jwt ? 200 : 401, body: null };
    if (!this.auth.creds) return { ok: false, status: 401, body: { error: "fără cont" } };
    const r = await this.raw("POST", "/api/internal/login", { email: this.auth.creds.email, password: this.auth.creds.password }, false);
    const j = (r.body as { jwt?: string } | null)?.jwt;
    if (r.ok && j) this.jwt = j; else this.jwt = null;
    return r.ok && j ? r : { ...r, ok: false };
  }
  async req(method: string, path: string, body?: unknown): Promise<Res> {
    if (!this.jwt && this.version === 3) { const l = await this.login(); if (!l.ok) return { ok: false, status: l.status, body: { error: "autentificarea la ChirpStack a eșuat" } }; }
    let r = await this.raw(method, path, body);
    if (r.status === 401 && this.version === 3) { const l = await this.login(); if (l.ok) r = await this.raw(method, path, body); }
    return r;
  }
  getDevice(eui: string) { return this.req("GET", `/api/devices/${eui}`); }
  createDevice(device: Record<string, unknown>) { return this.req("POST", "/api/devices", { device }); }
  deleteDevice(eui: string) { return this.req("DELETE", `/api/devices/${eui}`); }
  getKeys(eui: string) { return this.req("GET", `/api/devices/${eui}/keys`); }
  createKeys(eui: string, deviceKeys: Record<string, unknown>) { return this.req("POST", `/api/devices/${eui}/keys`, { deviceKeys }); }
  getActivation(eui: string) { return this.req("GET", `/api/devices/${eui}/activation`); }
  activate(eui: string, deviceActivation: Record<string, unknown>) { return this.req("POST", `/api/devices/${eui}/activate`, { deviceActivation }); }
  getQueue(eui: string) { return this.req("GET", `/api/devices/${eui}/queue`); }
  deleteQueue(eui: string) { return this.req("DELETE", `/api/devices/${eui}/queue`); }
  postQueue(eui: string, deviceQueueItem: Record<string, unknown>) { return this.req("POST", `/api/devices/${eui}/queue`, { deviceQueueItem }); }
}
