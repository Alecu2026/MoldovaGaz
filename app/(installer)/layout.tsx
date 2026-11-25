/** Ecranele pentru instalatori: ca în SCADA, fără bara de sus a aplicației (au propria bară, în pagină). */
import { Suspense } from "react";
import AuditTracker from "@/app/components/AuditTracker";
import ImpersonationNotice from "@/app/components/ImpersonationNotice";

export default function InstallerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}<Suspense fallback={null}><ImpersonationNotice /></Suspense><Suspense fallback={null}><AuditTracker /></Suspense></>;
}
