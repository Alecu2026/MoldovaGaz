/** Regulile pentru o parolă nouă (aceleași în browser și pe server; fără importuri de server). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
const WEAK = new Set(["parola123", "parola1234", "password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "abcd1234", "moldovagaz", "moldova123", "11111111", "00000000", "iloveyou", "admin1234", "administrator"]);

/** Întoarce un mesaj pentru utilizator dacă parola nu e bună, altfel null. */
export function passwordProblem(pw: string, ctx: { email?: string; current?: string } = {}): string | null {
  if (pw.length < PASSWORD_MIN) return `Parola trebuie să aibă cel puțin ${PASSWORD_MIN} caractere.`;
  if (pw.length > PASSWORD_MAX) return `Parola poate avea cel mult ${PASSWORD_MAX} de caractere.`;
  if (/^(.)\1+$/.test(pw)) return "Parola nu poate fi același caracter repetat.";
  const low = pw.toLowerCase();
  if (WEAK.has(low)) return "Parola este prea ușor de ghicit. Alege alta.";
  const email = (ctx.email ?? "").toLowerCase();
  if (email && (low === email || low === email.split("@")[0])) return "Parola nu poate fi chiar adresa de e-mail.";
  if (ctx.current !== undefined && pw === ctx.current) return "Parola nouă trebuie să fie diferită de cea veche.";
  if (/^\d+$/.test(pw)) return "Parola nu poate conține doar cifre.";
  return null;
}

/** Scor 0–4 pentru indicatorul de lângă câmp (doar orientativ; regulile reale sunt cele de mai sus). */
export function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}
