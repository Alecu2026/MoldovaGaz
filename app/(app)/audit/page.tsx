import { Suspense } from "react";
import type { Metadata } from "next";
import AuditLog from "@/app/components/AuditLog";
import { canOf } from "@/lib/access";
import { requirePage } from "@/lib/dal";

export const metadata: Metadata = { title: "Jurnal de audit" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  const user = await requirePage("audit");
  return <AuditLog canExport={canOf(user, "audit").export} />;
}
