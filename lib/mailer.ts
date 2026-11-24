import "server-only";
import nodemailer, { type Transporter } from "nodemailer";

/**
 * Trimiterea de e-mailuri prin SMTP (resetarea parolei). Totul vine din mediu (`.env.local`):
 *   SMTP_HOST, SMTP_PORT (implicit 587), SMTP_USER, SMTP_PASS (opționale dacă releul nu cere autentificare),
 *   SMTP_SECURE=1  → TLS direct (portul 465); altfel STARTTLS dacă serverul îl oferă (SMTP_REQUIRE_TLS=1 îl cere obligatoriu),
 *   SMTP_REJECT_UNAUTHORIZED=0 → acceptă certificate self-signed (releu intern),
 *   SMTP_FROM (ex. «Moldovagaz <no-reply@moldovagaz.md>»; implicit SMTP_USER),
 *   APP_URL (adresa publică a aplicației, ex. https://mg.dns.scada.md — pune-o în linkul din e-mail; fără ea nu se trimite nimic).
 * Fără aceste variabile funcția «Ai uitat parola?» e oprită (pagina o spune), nu se trimite nimic și nu se rupe nimic.
 */
const env = (k: string) => (process.env[k] ?? "").trim();
export const appUrl = (): string => env("APP_URL").replace(/\/+$/, "");
export const mailConfigured = (): boolean => !!(env("SMTP_HOST") && (env("SMTP_FROM") || env("SMTP_USER")) && /^https?:\/\/[^/]+/.test(appUrl()));
export const mailFrom = (): string => env("SMTP_FROM") || env("SMTP_USER");

const g = globalThis as unknown as { __mailTx?: { key: string; tx: Transporter } };
function transport(): Transporter {
  const key = [env("SMTP_HOST"), env("SMTP_PORT"), env("SMTP_USER"), env("SMTP_SECURE"), env("SMTP_REQUIRE_TLS"), env("SMTP_REJECT_UNAUTHORIZED")].join("|");
  if (g.__mailTx?.key === key) return g.__mailTx.tx;
  const secure = env("SMTP_SECURE") === "1";
  const tx = nodemailer.createTransport({
    host: env("SMTP_HOST"), port: Number(env("SMTP_PORT")) || (secure ? 465 : 587), secure,
    ...(env("SMTP_USER") ? { auth: { user: env("SMTP_USER"), pass: process.env.SMTP_PASS ?? "" } } : {}),
    requireTLS: !secure && env("SMTP_REQUIRE_TLS") === "1",
    tls: { rejectUnauthorized: env("SMTP_REJECT_UNAUTHORIZED") !== "0" },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  g.__mailTx = { key, tx };
  return tx;
}

export type Mail = { to: string; subject: string; text: string; html: string };
/** Trimite un e-mail. Aruncă o eroare scurtă (fără parole) dacă serverul de e-mail refuză. */
export async function sendMail(m: Mail): Promise<void> {
  if (!mailConfigured()) throw new Error("SMTP nu este configurat.");
  try {
    await transport().sendMail({ from: mailFrom(), to: m.to, subject: m.subject, text: m.text, html: m.html });
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message?: string };
    throw new Error(`Trimiterea a eșuat (${err.code ?? err.responseCode ?? "eroare"}): ${String(err.message ?? "").slice(0, 160)}`);
  }
}
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
