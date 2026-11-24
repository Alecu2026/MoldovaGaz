import "server-only";
import { ObjectId } from "mongodb";
import { ADMIN_ROLE, NO_ACCESS, can, cleanAccess, filOf, grantable, sameAccess, NO_CITY, type Access } from "../access";
import { canImpersonate } from "../impersonation";
import { cleanNotify, type NotifyType } from "../notify";
import { COLLECTIONS, col } from "../mongo";
import { actorOf } from "../audit-actor";
import { diffAccess, fmtAuditValue } from "../audit-diff";
import { hashPassword } from "../password";
import { logAudit } from "./audit";
import { forgetUser, notifyOf, viewerOf, type SessionUser, type UserDoc } from "../session";
import { getStore } from "./meter-dataset";

/**
 * Conturile aplicației (colecția `users`): creare, schimbare drepturi (pagini + filiale / orașe), parolă, dezactivare, ștergere.
 * Administrator = rolul `super_admin`; ceilalți sunt limitați la ce e bifat (vezi lib/access.ts). Nu atinge nicio altă colecție în afară de `sessions` (la ștergere / dezactivare).
 * Cine NU e administrator dar are dreptul la «Utilizatori» (editare / ștergere) lucrează doar în limita drepturilor lui: nu atinge administratori, nu își schimbă propriile drepturi
 * și nu poate da (sau gestiona conturi cu) mai mult decât are el — vezi `grantable`.
 */
export type UserView = { id: string; email: string; name: string; admin: boolean; disabled: boolean; access: Access; notify: NotifyType[]; createdAt: number | null; /** actorul poate intra în acest cont (simulare de login) */ imp: boolean; /** actorul îl poate modifica / șterge (drepturile lui se încadrează în ale actorului) */ manage: boolean; self: boolean };
type Err = { error: string; status: number };

const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{2,40}$/;
const view = (u: UserDoc, actor: SessionUser): UserView => {
  const v = viewerOf(u), self = String(u._id) === actor.id;
  const manage = actor.admin || (!v.admin && !self && grantable(actor, v.access));
  return { id: String(u._id), email: u.email, name: u.name ?? "", disabled: !!u.disabled, createdAt: u.createdAt instanceof Date ? u.createdAt.getTime() : null, notify: notifyOf(u), admin: v.admin, access: v.admin ? NO_ACCESS : v.access, manage, self,
    imp: canImpersonate(actor, can(actor, "users", "impersonate"), { id: String(u._id), admin: v.admin, disabled: !!u.disabled, access: v.access }).ok };
};
/** Actorul poate umbla la contul acesta? (administratorul orice; ceilalți doar conturi limitate, ale altora, încadrate în drepturile lor) */
const mayManage = (actor: SessionUser, target: UserDoc): boolean => { const v = viewerOf(target); return actor.admin || (!v.admin && String(target._id) !== actor.id && grantable(actor, v.access)); };

/** Administratorul vede toate conturile; ceilalți doar pe ale lor (cele pe care le pot gestiona) și contul propriu. */
export async function listUsers(actor: SessionUser): Promise<UserView[]> {
  const docs = await (await col<UserDoc>(COLLECTIONS.users)).find({}, { projection: { passwordHash: 0 } }).sort({ email: 1 }).toArray();
  return docs.filter((u) => actor.admin || String(u._id) === actor.id || mayManage(actor, u)).map((u) => view(u, actor));
}

/** Câți administratori activi are aplicația (ca să nu rămână niciunul). */
async function adminCount(exceptId?: string): Promise<number> {
  const q: Record<string, unknown> = { role: ADMIN_ROLE, disabled: { $ne: true } };
  if (exceptId && ObjectId.isValid(exceptId)) q._id = { $ne: new ObjectId(exceptId) };
  return (await col<UserDoc>(COLLECTIONS.users)).countDocuments(q);
}

export type NewUser = { email?: unknown; name?: unknown; password?: unknown; admin?: unknown; access?: unknown; notify?: unknown };

export async function createUser(b: NewUser, actor: SessionUser): Promise<{ user: UserView } | Err> {
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { error: "Adresa de e-mail nu e validă.", status: 400 };
  const password = String(b.password ?? "");
  if (password.length < 8 || password.length > 200) return { error: "Parola trebuie să aibă cel puțin 8 caractere.", status: 400 };
  const name = String(b.name ?? "").trim().slice(0, 80);
  const admin = b.admin === true;
  if (admin && !actor.admin) return { error: "Doar un administrator poate crea alt administrator.", status: 403 };
  let access: Access = NO_ACCESS;
  if (!admin) {
    const c = cleanAccess(b.access ?? NO_ACCESS);
    if ("error" in c) return { error: c.error, status: 400 };
    if (!grantable(actor, c.access)) return { error: "Nu poți da drepturi mai mari decât ai tu (acțiuni sau zonă).", status: 403 };
    access = c.access;
  }
  const nt = cleanNotify(b.notify);
  if ("error" in nt) return { error: nt.error, status: 400 };
  const users = await col<UserDoc>(COLLECTIONS.users);
  if (await users.findOne({ email }, { projection: { _id: 1 } })) return { error: "Există deja un cont cu această adresă.", status: 409 };
  const now = new Date();
  const doc = { email, name: name || email, passwordHash: await hashPassword(password), role: admin ? ADMIN_ROLE : "user", access: admin ? undefined : access, notify: nt.notify, disabled: false, createdAt: now, updatedAt: now };
  const r = await users.insertOne(doc as never);
  await logAudit(actorOf(actor), { action: "user.create", objectId: String(r.insertedId), objectName: email, changes: admin ? [] : diffAccess(null, access), extra: [{ label: "Tip cont", value: admin ? "administrator (drepturi complete)" : "limitat" }, { label: "Nume afișat", value: name || email }, { label: "Notificări", value: nt.notify.join(", ") || "niciuna" }] });
  return { user: view({ ...doc, _id: r.insertedId } as UserDoc, actor) };
}

export async function updateUser(id: string, b: NewUser & { disabled?: unknown }, actor: SessionUser): Promise<{ user: UserView } | Err> {
  const actorId = actor.id;
  if (!ObjectId.isValid(id)) return { error: "Cont invalid.", status: 400 };
  const users = await col<UserDoc>(COLLECTIONS.users);
  const cur = await users.findOne({ _id: new ObjectId(id) });
  if (!cur) return { error: "Contul nu există.", status: 404 };
  if (!actor.admin) {
    // fără drept de administrator: contul propriu doar nume / parolă / notificări; conturile altora doar dacă se încadrează în drepturile lui
    if (id === actorId) {
      if (b.admin === true || b.disabled === true) return { error: "Nu-ți poți schimba singur drepturile.", status: 403 };
      if (b.access !== undefined) { const c = cleanAccess(b.access); if ("error" in c || !sameAccess(c.access, viewerOf(cur).access)) return { error: "Nu-ți poți schimba singur drepturile.", status: 403 }; }
    } else {
      if (!mayManage(actor, cur)) return { error: "Nu poți modifica acest cont.", status: 403 };
      if (b.admin === true) return { error: "Doar un administrator poate da drepturi de administrator.", status: 403 };
    }
  }
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
  if (id === actorId && (disabled || (wasAdmin && !admin))) return { error: "Nu-ți poți scoate singur drepturile de administrator sau dezactiva contul.", status: 400 };
  if (wasAdmin && !cur.disabled && (!admin || disabled) && (await adminCount(id)) === 0) return { error: "Trebuie să rămână cel puțin un administrator activ.", status: 400 };
  if (b.notify !== undefined) {
    const nt = cleanNotify(b.notify);
    if ("error" in nt) return { error: nt.error, status: 400 };
    set.notify = nt.notify;
  }
  set.role = admin ? ADMIN_ROLE : "user";
  set.disabled = disabled;
  if (admin) unset.access = "";
  else if (b.access !== undefined) {
    const c = cleanAccess(b.access);
    if ("error" in c) return { error: c.error, status: 400 };
    if (!grantable(actor, c.access)) return { error: "Nu poți da drepturi mai mari decât ai tu (acțiuni sau zonă).", status: 403 };
    set.access = c.access;
  }
  const beforeView = viewerOf(cur), beforeNotify = notifyOf(cur);
  await users.updateOne({ _id: cur._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  {
    const who = { objectId: id, objectName: cur.email }, a = actorOf(actor);
    const basic = [] as { field: string; label: string; old: string | null; new: string | null }[];
    if (set.name !== undefined && set.name !== (cur.name ?? cur.email)) basic.push({ field: "name", label: "Nume afișat", old: cur.name ?? null, new: String(set.name) });
    if (b.notify !== undefined && set.notify) { const was = beforeNotify.join(", ") || null, now = (set.notify as string[]).join(", ") || null; if (was !== now) basic.push({ field: "notify", label: "Notificări primite", old: was, new: now }); }
    if (basic.length) await logAudit(a, { action: "user.update", ...who, changes: basic });
    if (set.passwordHash) await logAudit(a, { action: "user.password_change", ...who, extra: [{ label: "Notă", value: "Valoarea parolei nu se păstrează. Contul a fost deconectat de pe toate dispozitivele." }] });
    if (admin !== wasAdmin) await logAudit(a, { action: "user.admin_change", ...who, changes: [{ field: "admin", label: "Administrator", old: fmtAuditValue(wasAdmin), new: fmtAuditValue(admin) }] });
    if (disabled !== !!cur.disabled) await logAudit(a, { action: "user.status_change", ...who, changes: [{ field: "disabled", label: "Cont dezactivat", old: fmtAuditValue(!!cur.disabled), new: fmtAuditValue(disabled) }] });
    if (!admin && set.access) { const ch = diffAccess(wasAdmin ? null : beforeView.access, set.access as Access); if (ch.length) await logAudit(a, { action: "user.permissions_change", ...who, changes: ch }); }
  }
  if (disabled || set.passwordHash) await (await col(COLLECTIONS.sessions)).deleteMany({ $or: [{ userId: id }, { impersonatorId: id }] }); // dezactivat / parolă nouă ⇒ iese de pe toate dispozitivele
  forgetUser(id);
  const next = await users.findOne({ _id: cur._id }, { projection: { passwordHash: 0 } });
  return next ? { user: view(next, actor) } : { error: "Contul nu există.", status: 404 };
}

export async function deleteUser(id: string, actor: SessionUser): Promise<{ ok: true } | Err> {
  if (!ObjectId.isValid(id)) return { error: "Cont invalid.", status: 400 };
  if (id === actor.id) return { error: "Nu-ți poți șterge propriul cont.", status: 400 };
  const users = await col<UserDoc>(COLLECTIONS.users);
  const cur = await users.findOne({ _id: new ObjectId(id) });
  if (!cur) return { error: "Contul nu există.", status: 404 };
  if (!mayManage(actor, cur)) return { error: "Nu poți șterge acest cont.", status: 403 };
  if (cur.role === ADMIN_ROLE && !cur.disabled && (await adminCount(id)) === 0) return { error: "Trebuie să rămână cel puțin un administrator activ.", status: 400 };
  await logAudit(actorOf(actor), { action: "user.delete", objectId: id, objectName: cur.email, extra: [{ label: "Tip cont", value: cur.role === ADMIN_ROLE ? "administrator" : "limitat" }, { label: "Nume afișat", value: cur.name ?? cur.email }, { label: "Stare", value: cur.disabled ? "dezactivat" : "activ" }] });
  await users.deleteOne({ _id: cur._id });
  await (await col(COLLECTIONS.sessions)).deleteMany({ $or: [{ userId: id }, { impersonatorId: id }] });
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
