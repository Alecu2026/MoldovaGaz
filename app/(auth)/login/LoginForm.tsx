"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { loginAction, type LoginState } from "@/app/actions/auth";

export default function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, null);
  const [show, setShow] = useState(false);

  return (
    <form action={action} style={{ display: "grid", gap: 14 }} noValidate={false}>
      <label className="field">
        <span>Email</span>
        <input
          className="input"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          maxLength={254}
          defaultValue={state?.email ?? ""}
          aria-invalid={!!state?.error}
          aria-describedby={state?.error ? "login-error" : undefined}
        />
      </label>
      <label className="field">
        <span>Parolă</span>
        <div style={{ position: "relative" }}>
          <input
            className="input"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={200}
            style={{ paddingRight: 84 }}
            aria-invalid={!!state?.error}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShow((s) => !s)}
            aria-pressed={show}
            style={{ position: "absolute", right: 3, top: 3 }}
          >
            {show ? "Ascunde" : "Arată"}
          </button>
        </div>
      </label>
      {state?.error && (
        <p id="login-error" role="alert" className="form-error">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary" type="submit" disabled={pending} style={{ height: 40 }}>
        {pending ? "Se verifică…" : "Autentificare"}
      </button>
      <Link href="/uita-parola" className="btn btn-ghost btn-sm" style={{ justifySelf: "center" }}>
        Ai uitat parola?
      </Link>
    </form>
  );
}
