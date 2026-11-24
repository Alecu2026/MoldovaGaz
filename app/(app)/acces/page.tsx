import { Suspense } from "react";
import type { Metadata } from "next";
import { firstPath } from "@/lib/access";
import { requireUser } from "@/lib/dal";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Acces" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true" />}>
      <Gate />
    </Suspense>
  );
}

/** Cont fără nicio pagină bifată (sau trimis aici dintr-o pagină la care nu are drept). */
async function Gate() {
  const user = await requireUser();
  const to = firstPath(user);
  if (to) redirect(to);
  return (
    <div className="page">
      <div className="empty">
        <h2>Contul tău nu are încă acces la nicio pagină</h2>
        <p>Cere unui administrator să-ți bifeze paginile și zona (filiale / orașe) pe care ai voie să le vezi.</p>
      </div>
    </div>
  );
}
