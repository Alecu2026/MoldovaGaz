import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { checkResetToken } from "@/lib/services/account";
import AuthShell from "../AuthShell";
import ResetForm from "./ResetForm";

// linkul din e-mail conține tokenul: nu se trimite mai departe în antetul Referer
export const metadata: Metadata = { title: "Parolă nouă", referrer: "no-referrer", robots: { index: false, follow: false } };

export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <AuthShell sub="Parolă nouă"><Suspense fallback={<div className="skeleton" style={{ height: 160 }} aria-busy="true" />}><Gate searchParams={searchParams} /></Suspense></AuthShell>;
}

async function Gate({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const ok = token ? await checkResetToken(token).catch(() => null) : null;
  if (!ok) return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="form-error" role="alert" style={{ whiteSpace: "normal" }}>Linkul nu mai este valabil: a expirat sau a fost deja folosit. Cere unul nou.</p>
      <Link className="btn btn-primary" href="/uita-parola" style={{ textAlign: "center" }}>Cere un link nou</Link>
      <Link className="btn btn-ghost" href="/login" style={{ textAlign: "center" }}>Înapoi la autentificare</Link>
    </div>
  );
  return <ResetForm token={token} email={ok.email} />;
}
