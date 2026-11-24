import BrandMark from "@/app/components/BrandMark";

/** Cadrul paginilor de acces (autentificare, «Ai uitat parola?», resetare): același card ca la login. */
export default function AuthShell({ children, sub = "Monitorizare contoare de gaz" }: { children: React.ReactNode; sub?: string }) {
  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ marginBottom: 22 }}>
          <div className="brand-mark"><BrandMark size={24} /></div>
          <div><div className="brand-name">Moldovagaz</div><div className="brand-sub">{sub}</div></div>
        </div>
        {children}
      </div>
    </main>
  );
}
