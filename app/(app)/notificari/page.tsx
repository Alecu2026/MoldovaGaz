import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import NotificationsPanel from "@/app/components/NotificationsPanel";
import { firstPath } from "@/lib/access";
import { requireUser } from "@/lib/dal";

export const metadata: Metadata = { title: "Notificări" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

/** Doar conturile care primesc cel puțin un tip de notificări (bifat la «Utilizatori»). */
async function Gate() {
  const user = await requireUser();
  if (!user.notify.length) redirect(firstPath(user) ?? "/acces");
  return <NotificationsPanel />;
}
