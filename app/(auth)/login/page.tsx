import type { Metadata } from "next";
import BrandMark from "@/app/components/BrandMark";
import LoginForm from "./LoginForm";

export const metadata: Metadata = { title: "Autentificare" };

/** Pagină statică (fără date de cerere): intră în shell-ul prerandat și se afișează instant. */
export default function LoginPage() {
  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ marginBottom: 22 }}>
          <div className="brand-mark">
            <BrandMark size={24} />
          </div>
          <div>
            <div className="brand-name">Moldovagaz</div>
            <div className="brand-sub">Monitorizare contoare LoRaWAN</div>
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
