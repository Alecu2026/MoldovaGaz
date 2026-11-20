import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy (fostul middleware) — verificare OPTIMISTĂ, fără DB: doar prezența cookie-ului decide redirectul rapid.
 * Validarea reală a sesiunii se face în lib/dal.ts (pagini) și în fiecare route handler (/api/uplinks/*).
 * /api nu trece pe aici: API-urile răspund cu 401 JSON (nu cu redirect), iar /api/ingest are propriul token.
 */
const COOKIE = "mg_session";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has(COOKIE);
  if (!hasSession && pathname !== "/login") return NextResponse.redirect(new URL("/login", req.nextUrl));
  if (hasSession && pathname === "/login") return NextResponse.redirect(new URL("/", req.nextUrl));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webp|jpg|txt|webmanifest)$).*)"],
};
