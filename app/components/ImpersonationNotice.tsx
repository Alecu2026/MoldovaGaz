import ImpersonationBanner from "./ImpersonationBanner";
import { getCurrentUser } from "@/lib/dal";

/** Pe server: arată bara de simulare doar dacă sesiunea curentă e o simulare de login. */
export default async function ImpersonationNotice() {
  const u = await getCurrentUser();
  if (!u?.impersonation) return null;
  return <ImpersonationBanner who={u.name} by={u.impersonation.byName} expiresAt={u.impersonation.expiresAt} />;
}
