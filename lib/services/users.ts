import "server-only";
import { ObjectId } from "mongodb";
import { ADMIN_ROLE, NO_ACCESS, cleanAccess, filOf, NO_CITY, type Access } from "../access";
import { COLLECTIONS, col } from "../mongo";
import { hashPassword } from "../password";
import { forgetUser, viewerOf, type UserDoc } from "../session";
import { getStore } from "./meter-dataset";

/**
 * Conturile aplicației (colecția `users`): creare, schimbare drepturi (pagini + filiale / orașe), parolă, dezactivare, ștergere.
 * Administrator = rolul `super_admin`; ceilalți sunt limitați la ce e bifat (vezi lib/access.ts). Nu atinge nicio altă colecție în afară de `sessions` (la ștergere / dezactivare).
 */
export type UserView = { id: string; email: string; name: string; admin: boolean; disabled: boolean; access: Access; createdAt: number | null };
type Err = { error: string; status: number };

const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{2,40}$/;
const view = (u: UserDoc): UserView => ({ id: String(u._id), email: u.email, name: u.name ?? "", disabled: !!u.disabled, createdAt: u.createdAt instanceof Date ? u.createdAt.getTime() : null, ...(() => { const v = viewerOf(u); return { admin: v.admin, access: v.admin ? NO_ACCESS : v.access }; })() });

export async function listUsers(): Promise<UserView[]> {
  const docs = await (await col<UserDoc>(COLLECTIONS.users)).find({}, { projection: { passwordHash: 0 } }).sort({ email: 1 }).toArray();
  return docs.map(view);
}

/** Câți administratori activi are aplicația (ca să nu rămână niciunul). */
async function adminCount(exceptId?: string): Promise<number> {
  const q: Record<string, unknown> = { role: ADMIN_ROLE, disabled: { $ne: true } };
  if (exceptId && ObjectId.isValid(exceptId)) q._id = { $ne: new ObjectId(exceptId) };
  return (await col<UserDoc>(COLLECTIONS.users)).countDocuments(q);
}

export type NewUser = { email?: unknown; name?: unknown; password?: unknown; admin?: unknown; access?: unknown };

export async function createUser(b: NewUser): Promise<{ user: UserView } | Err> {
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { error: "Adresa de e-mail nu e validă.", status: 400 };
  const password = String(b.password ?? "");
  if (password.length < 8 || password.length > 200) return { error: "Parola trebuie să aibă cel puțin 8 caractere.", status: 400 };
  const name = String(b.name ?? "").trim().slice(0, 80);
  const admin = b.admin === true;
  let access: Access = NO_ACCESS;
  if (!admin) {
    const c = cleanAccess(b.access ?? NO_ACCESS);
    if ("error" in c) return { error: c.error, status: 400 };
    access = c.access;
  }
  const users = await col<UserDoc>(COLLECTIONS.users);
  if (await users.findOne({ email }, { projection: { _id: 1 } })) return { error: "Există deja un cont cu această adresă.", status: 409 };
  const now = new Date();
  const doc = { email, name: name || email, passwordHash: await hashPassword(password), role: admin ? ADMIN_ROLE : "user", access: admin ? undefined : access, disabled: false, createdAt: now, updatedAt: now };
  const r = await users.insertOne(doc as never);
  return { user: view({ ...doc, _id: r.insertedId } as UserDoc) };
}

export async function updateUser(id: string, b: NewUser & { disabled?: unknown }, actorId: string): Promise<{ user: UserView } | Err> {
  if (!ObjectId.isValid(id)) return { error: "Cont invalid.", status: 400 };
  const users = await col<UserDoc>(COLLECTIONS.users);
  const cur = await users.findOne({ _id: new ObjectId(id) });
  if (!cur) return { error: "Contul nu există.", status: 404 };
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const unset: Record<string, ""> = {};
  const wasAdmin = cur.role === ADMIN_ROLE;
  const admin = b.admin === undefined ? wasAdmin : b.admin === true;
  const disabled = b.disabled === undefined ? !!cur.disabled : b.disabled === true;
  if (b.name !== undefined) set.name = String(b.name).trim().slice(0, 80) || cur.email;
  if (b.password !== undefined && String(b.password) !== "") {
    const p = String(b.password);
    if (p.length < 8 || p.length > 200) return { error: "Parola trebuie să aibă cel puțin 8 caractere.", status: 400 };
    set.passwordHash = await hashPassword(p);
  }
  if (id === actorId && (!admin || disabled)) return { error: "Nu-ți poți scoate singur drepturile de administrator sau dezactiva contul.", status: 400 };
  if (wasAdmin && !cur.disabled && (!admin || disabled) && (await adminCount(id)) === 0) return { error: "Trebuie să rămână cel puțin un administrator activ.", status: 400 };
  set.role = admin ? ADMIN_ROLE : "user";
  set.disabled = disabled;
  if (admin) unset.access = "";
  else if (b.access !== undefined) {
    const c = cleanAccess(b.access);
    if ("error" in c) return { error: c.error, status: 400 };
    set.access = c.access;
  }
  await users.updateOne({ _id: cur._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  if (disabled || set.passwordHash) await (await col(COLLECTIONS.sessions)).deleteMany({ userId: id }); // dezactivat / parolă nouă ⇒ iese de pe toate dispozitivele
  forgetUser(id);
  const next = await users.findOne({ _id: cur._id }, { projection: { passwordHash: 0 } });
  return next ? { user: view(next) } : { error: "Contul nu există.", status: 404 };
}

export async function deleteUser(id: string, actorId: string): Promise<{ ok: true } | Err> {
  if (!ObjectId.isValid(id)) return { error: "Cont invalid.", status: 400 };
  if (id === actorId) return { error: "Nu-ți poți șterge propriul cont.", status: 400 };
  const users = await col<UserDoc>(COLLECTIONS.users);
  const cur = await users.findOne({ _id: new ObjectId(id) });
  if (!cur) return { error: "Contul nu există.", status: 404 };
  if (cur.role === ADMIN_ROLE && !cur.disabled && (await adminCount(id)) === 0) return { error: "Trebuie să rămână cel puțin un administrator activ.", status: 400 };
  await users.deleteOne({ _id: cur._id });
  await (await col(COLLECTIONS.sessions)).deleteMany({ userId: id });
  forgetUser(id);
  return { ok: true };
}

export type ScopeBranch = { fil: string; label: string; count: number; cities: { city: string; count: number }[] };

/** Filialele și orașele din lista de contoare (din memorie), pentru arborele de bife de la utilizatori. */
export async function scopeOptions(): Promise<ScopeBranch[]> {
  const st = await getStore();
  const c = st.cols, d = st.dict;
  const by = new Map<string, { label: string; count: number; cities: Map<string, number> }>();
  for (let i = 0; i < c.id.length; i++) {
    const label = c.br[i] >= 0 ? d.br[c.br[i]] : "";
    const fil = filOf(label);
    if (!/^\d{1,3}$/.test(fil)) continue; // „Nedeterminată”: fără filială, nu se poate bifa
    let b = by.get(fil);
    if (!b) by.set(fil, (b = { label, count: 0, cities: new Map() }));
    b.count++;
    const city = c.ct[i] >= 0 ? d.ct[c.ct[i]] || NO_CITY : NO_CITY;
    b.cities.set(city, (b.cities.get(city) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([fil, b]) => ({ fil, label: b.label, count: b.count, cities: [...b.cities.entries()].map(([city, count]) => ({ city, count })).sort((x, y) => x.city.localeCompare(y.city, "ro")) }));
}
