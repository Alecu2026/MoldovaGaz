import { Suspense } from "react";
import type { Metadata } from "next";
import UsersPanel from "@/app/components/UsersPanel";
import { canOf } from "@/lib/access";
import { requirePage } from "@/lib/dal";

export const metadata: Metadata = { title: "Utilizatori" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  const user = await requirePage("users");
  return <UsersPanel can={canOf(user, "users")} />;
}
