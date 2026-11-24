import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy (fostul middleware) — verificare OPTIMISTĂ, fără DB: doar prezența cookie-ului decide redirectul rapid.
 * Validarea reală a sesiunii se face în lib/dal.ts (pagini) și în fiecare route handler (/api/meters/*).
 * /api nu trece pe aici: API-urile răspund cu 401 JSON (nu cu redirect).
 */
const COOKIE = "mg_session";
const PUBLIC = new Set(["/login", "/uita-parola", "/reset-parola"]); // paginile accesibile fără autentificare
const ORIG = "mg_session_orig"; // sesiunea proprie, cât ține o simulare de login (lib/services/impersonation.ts)

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has(COOKIE);
  // simularea de login a expirat (cookie-ul ei a dispărut): sesiunea proprie revine singură, fără autentificare nouă
  const orig = req.cookies.get(ORIG)?.value;
  if (!hasSession && orig) {
    const res = NextResponse.redirect(req.nextUrl);
    const https = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https" || req.nextUrl.protocol === "https:";
    res.cookies.set(COOKIE, orig, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" && https && !process.env.INSECURE_COOKIES, maxAge: 14 * 86_400 });
    res.cookies.delete(ORIG);
    return res;
  }
  if (!hasSession && !PUBLIC.has(pathname)) return NextResponse.redirect(new URL("/login", req.nextUrl));
  if (hasSession && pathname === "/login") return NextResponse.redirect(new URL("/", req.nextUrl));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webp|jpg|txt|webmanifest)$|sw\\.js$).*)"],
};
