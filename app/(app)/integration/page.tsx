import { Suspense } from "react";
import type { Metadata } from "next";
import IntegrationPanel from "@/app/components/IntegrationPanel";
import { canOf } from "@/lib/access";
import { requirePage } from "@/lib/dal";

export const metadata: Metadata = { title: "Integrare" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  const user = await requirePage("integration");
  return <IntegrationPanel can={canOf(user, "integration")} />;
}
