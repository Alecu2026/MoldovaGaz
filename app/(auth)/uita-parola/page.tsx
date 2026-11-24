import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { mailConfigured } from "@/lib/mailer";
import AuthShell from "../AuthShell";
import ForgotForm from "./ForgotForm";

export const metadata: Metadata = { title: "Ai uitat parola?", referrer: "no-referrer" };

export default function Page() {
  return <AuthShell sub="Resetarea parolei"><Suspense fallback={<div className="skeleton" style={{ height: 120 }} aria-busy="true" />}><Gate /></Suspense></AuthShell>;
}

async function Gate() {
  await connection(); // configurarea SMTP se citește la cerere (nu se prerandează)
  return <ForgotForm enabled={mailConfigured()} />;
}
