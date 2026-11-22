"use client";

import { useRef } from "react";
import { logoutAction } from "@/app/actions/auth";
import { clearMeterCaches } from "./useMeterStore";

export default function LogoutButton() {
  const cleared = useRef(false);
  return (
    <form
      action={logoutAction}
      onSubmit={async (e) => {
        if (cleared.current) return;
        e.preventDefault();
        const form = e.currentTarget;
        await clearMeterCaches(); // lista din memorie / IndexedDB nu rămâne în browser după ieșire
        cleared.current = true;
        form.requestSubmit();
      }}
    >
      <button className="btn btn-sm" type="submit">
        Ieșire
      </button>
    </form>
  );
}
