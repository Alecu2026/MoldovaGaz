"use client";

/**
 * Ajutoare pentru notificări în browser: sunetul propriu al aplicației (două tonuri, fără fișier audio), abonarea / dezabonarea la push și starea dispozitivului.
 * Sunetul se aude doar când aplicația e deschisă; când e închisă, notificarea sosește prin sistem (cu sunetul implicit al telefonului / calculatorului).
 */
const SOUND_KEY = "mg:notifSound";
let ctx: AudioContext | null = null;
const ACtx = (): typeof AudioContext | null => (typeof window === "undefined" ? null : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null);

/** Browserele permit sunet abia după o atingere / un click: la prima interacțiune se „deblochează” contextul audio. */
export function unlockAudio(): void {
  const A = ACtx();
  if (!A) return;
  try { ctx ??= new A(); if (ctx.state === "suspended") void ctx.resume(); } catch { /* fără audio */ }
}
export const soundEnabled = (): boolean => { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } };
export const setSoundEnabled = (on: boolean): void => { try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch { /* alegerea nu se reține */ } };

/** Sunetul de alertă: trei tonuri scurte (crit: mai insistent). */
export function playAlert(level: "warn" | "crit" = "warn"): void {
  unlockAudio();
  if (!ctx || ctx.state !== "running") return;
  const c = ctx, t0 = c.currentTime + 0.02;
  const tones = level === "crit" ? [880, 660, 880, 660, 880] : [880, 660, 880];
  tones.forEach((f, i) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = "sine"; o.frequency.value = f;
    const s = t0 + i * 0.2;
    g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.25, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.17);
    o.connect(g).connect(c.destination); o.start(s); o.stop(s + 0.18);
  });
}

export const pushSupported = (): boolean => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** iPhone / iPad: notificările push merg doar după „Adaugă pe ecranul principal” (aplicație instalată). */
export const needsInstall = (): boolean => {
  if (typeof window === "undefined") return false;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
};

const b64 = (s: string): Uint8Array<ArrayBuffer> => {
  const p = "=".repeat((4 - (s.length % 4)) % 4), raw = atob((s + p).split("-").join("+").split("_").join("/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export async function registerSw(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch { return null; }
}
export async function currentSub(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try { const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSw()); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
}

/** Cere permisiunea, abonează dispozitivul și trimite abonamentul la server. Întoarce un mesaj de eroare sau null. */
export async function enablePush(publicKey: string): Promise<string | null> {
  if (!pushSupported()) return needsInstall() ? "Pe iPhone / iPad: apasă «Partajează» → «Adaugă pe ecranul principal», deschide aplicația de acolo și activează din nou." : "Acest browser nu suportă notificări push.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "Notificările sunt blocate pentru acest site. Permite-le din setările browserului." : "Permisiunea nu a fost acordată.";
  try {
    const reg = (await registerSw()) ?? (await navigator.serviceWorker.ready);
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) }));
    const r = await fetch("/api/notifications/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    if (!r.ok) return "Serverul a refuzat abonamentul.";
    return null;
  } catch (e) {
    return `Nu am putut activa notificările (${(e as Error).message || "eroare"}).`;
  }
}
export async function disablePush(): Promise<void> {
  const sub = await currentSub();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  await fetch("/api/notifications/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) }).catch(() => undefined);
}
