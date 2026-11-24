import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import SecurityPanel from "@/app/components/SecurityPanel";
import { requireUser } from "@/lib/dal";

export const metadata: Metadata = { title: "Securitate" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 220, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

/** Orice cont autentificat își vede pagina lui; în simulare de login nu (ar fi parola contului simulat). */
async function Gate() {
  const user = await requireUser();
  if (user.impersonation) redirect("/");
  return <SecurityPanel email={user.email} name={user.name} />;
}
