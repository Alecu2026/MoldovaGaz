import type { Db } from "mongodb";
import webpush from "web-push";

/**
 * Notificări push (Web Push, standard): cheile VAPID se generează o singură dată și se păstrează în colecția `notif_config` (nu trebuie nicio variabilă de mediu);
 * cheia publică ajunge la browser, cea privată rămâne pe server. Un abonament = un browser / telefon al unui utilizator (`push_subs`).
 */
export const CONFIG_COLLECTION = "notif_config";
export const SUBS_COLLECTION = "push_subs";
export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };
export type SendResult = "ok" | "gone" | "fail";
export type Sender = (sub: PushSub, payload: string) => Promise<SendResult>;
type Vapid = { publicKey: string; privateKey: string; subject: string };

export async function getVapid(db: Db): Promise<Vapid> {
  const coll = db.collection<{ _id: string } & Vapid>(CONFIG_COLLECTION);
  const have = await coll.findOne({ _id: "vapid" });
  if (have) return { publicKey: have.publicKey, privateKey: have.privateKey, subject: process.env.VAPID_SUBJECT || have.subject };
  const k = webpush.generateVAPIDKeys();
  const doc = { publicKey: k.publicKey, privateKey: k.privateKey, subject: process.env.VAPID_SUBJECT || "https://mg.dns.scada.md" };
  // două procese pot ajunge aici deodată: câștigă primul, celălalt citește cheile lui
  await coll.updateOne({ _id: "vapid" }, { $setOnInsert: doc }, { upsert: true });
  const won = await coll.findOne({ _id: "vapid" });
  return won ? { publicKey: won.publicKey, privateKey: won.privateKey, subject: doc.subject } : doc;
}

/** Trimite o notificare unui abonament; „gone” = abonamentul nu mai există (browserul l-a șters) și trebuie scos din bază. */
export async function webPushSender(db: Db): Promise<Sender> {
  const v = await getVapid(db);
  return async (sub, payload) => {
    try {
      await webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: "high", vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey }, timeout: 15_000 });
      return "ok";
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) return "gone";
      console.error(`[push] trimiterea a eșuat (${code ?? "fără cod"}): ${(e as Error).message}`.slice(0, 300)); // fără endpoint / chei în jurnal
      return "fail";
    }
  };
}

/** Valideaza un abonament trimis de browser (endpoint https + chei). */
export function cleanSub(raw: unknown): PushSub | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const ep = typeof b.endpoint === "string" ? b.endpoint : "";
  const p = b.keys?.p256dh, a = b.keys?.auth;
  if (!/^https:\/\/[^\s]{10,1000}$/.test(ep) || typeof p !== "string" || typeof a !== "string" || p.length < 20 || p.length > 200 || a.length < 8 || a.length > 100) return null;
  return { endpoint: ep, keys: { p256dh: p, auth: a } };
}
