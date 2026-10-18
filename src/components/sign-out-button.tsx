"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    setBusy(true);
    const result = await createClient().auth.signOut();
    setBusy(false);
    if (result.error) {
      setError("로그아웃에 실패했습니다. 다시 시도해 주세요.");
      return;
    }
    router.refresh();
  }

  return <span className="signout-group"><button type="button" className="text-button" onClick={signOut} disabled={busy}>로그아웃</button>{error && <span role="alert">{error}</span>}</span>;
}
