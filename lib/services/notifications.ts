import "server-only";
import { createHash } from "node:crypto";
import { eventVisible, type NotifyEvent, type NotifyType } from "../notify";
import { EVENTS_COLLECTION, deliver } from "../alert-job";
import { getDb } from "../mongo";
import { SUBS_COLLECTION, getVapid, webPushSender, type PushSub } from "../push";
import type { SessionUser } from "../session";

/** Notificările unui utilizator: lista problemelor din zona lui (doar tipurile bifate la cont), „necitite”, abonamentele push ale dispozitivelor lui. */
export const SEEN_COLLECTION = "notif_seen";
type EventDoc = { _id: string; type: NotifyType; level: "warn" | "crit"; title: string; body: string; zones: string[]; openedAt: Date; at: Date; resolvedAt: Date | null };

export async function publicKey(): Promise<string> { return (await getVapid(await getDb())).publicKey; }

export async function seenAt(userId: string): Promise<number> {
  const d = await (await getDb()).collection<{ _id: string; at: Date }>(SEEN_COLLECTION).findOne({ _id: userId });
  return d?.at ? d.at.getTime() : 0;
}
export async function markSeen(userId: string): Promise<void> {
  await (await getDb()).collection<{ _id: string; at: Date }>(SEEN_COLLECTION).updateOne({ _id: userId }, { $set: { at: new Date() } }, { upsert: true });
}

export type NotifList = { events: NotifyEvent[]; unread: number; seenAt: number };
export async function listFor(user: SessionUser): Promise<NotifList> {
  if (!user.notify.length) return { events: [], unread: 0, seenAt: 0 };
  const db = await getDb();
  const docs = await db.collection<EventDoc>(EVENTS_COLLECTION).find({ type: { $in: user.notify } }).sort({ at: -1 }).limit(300).toArray();
  const seen = await seenAt(user.id);
  const events: NotifyEvent[] = docs.filter((d) => eventVisible(user, d.zones)).slice(0, 100).map((d) => ({
    id: d._id, type: d.type, key: d._id, level: d.level, title: d.title, body: d.body, zones: user.admin ? d.zones : d.zones.filter((z) => eventVisible(user, [z])),
    openedAt: d.openedAt.getTime(), at: d.at.getTime(), resolvedAt: d.resolvedAt ? d.resolvedAt.getTime() : null,
  }));
  return { events, unread: events.filter((e) => e.resolvedAt === null && e.at > seen).length, seenAt: seen };
}

const subId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
export async function saveSub(userId: string, sub: PushSub, ua: string): Promise<void> {
  await (await getDb()).collection(SUBS_COLLECTION).updateOne({ _id: subId(sub.endpoint) as never }, { $set: { userId, endpoint: sub.endpoint, keys: sub.keys, ua: ua.slice(0, 200), at: new Date() } }, { upsert: true });
}
export async function removeSub(userId: string, endpoint: string): Promise<void> {
  await (await getDb()).collection(SUBS_COLLECTION).deleteOne({ _id: subId(endpoint) as never, userId });
}
export async function subCount(userId: string): Promise<number> {
  return (await getDb()).collection(SUBS_COLLECTION).countDocuments({ userId });
}

/** O notificare de probă, doar către dispozitivele utilizatorului. */
export async function sendTest(user: SessionUser): Promise<{ sent: number; gone: number; failed: number }> {
  const db = await getDb();
  const subs = await db.collection<{ _id: unknown; userId: string } & PushSub>(SUBS_COLLECTION).find({ userId: user.id }).toArray();
  const send = await webPushSender(db);
  const payload = JSON.stringify({ title: "Notificare de probă", body: "Așa vor arăta și sună notificările despre probleme.", url: "/notificari", tag: "test", level: "warn", type: "test" });
  const res = { sent: 0, gone: 0, failed: 0 };
  const dead: unknown[] = [];
  for (const s of subs) { const r = await send({ endpoint: s.endpoint, keys: s.keys }, payload); if (r === "ok") res.sent++; else if (r === "gone") { res.gone++; dead.push(s._id); } else res.failed++; }
  if (dead.length) await db.collection(SUBS_COLLECTION).deleteMany({ _id: { $in: dead as never[] } });
  return res;
}
export { deliver };
