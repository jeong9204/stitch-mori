"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

export function EmailOtpForm({ nextPath = "/import" }: { nextPath?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const { error } = await createClient().auth.signInWithOtp({ email: email.trim() });
    setBusy(false);
    if (error) {
      setMessage(`인증 코드를 보낼 수 없습니다: ${error.message}`);
      return;
    }
    setSent(true);
    setMessage("인증 코드를 보냈습니다. 이메일을 확인해 주세요.");
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const { error } = await createClient().auth.verifyOtp({
      email: email.trim(),
      token: token.trim(),
      type: "email",
    });
    setBusy(false);
    if (error) {
      setMessage(`인증에 실패했습니다: ${error.message}`);
      return;
    }
    router.push(nextPath);
    router.refresh();
  }

  return (
    <div className="auth-form">
      <form onSubmit={sendCode}>
        <label htmlFor="email">이메일 주소</label>
        <input id="email" type="email" autoComplete="email" required value={email}
          onChange={(event) => setEmail(event.target.value)} disabled={busy || sent} />
        {!sent && <button className="button" type="submit" disabled={busy}>인증 코드 받기</button>}
      </form>
      {sent && (
        <form onSubmit={verifyCode}>
          <label htmlFor="otp">인증 코드</label>
          <input id="otp" type="text" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} required value={token}
            onChange={(event) => setToken(event.target.value.replace(/\D/g, ""))} disabled={busy} />
          <button className="button" type="submit" disabled={busy}>코드 확인</button>
          <button className="text-button" type="button" disabled={busy} onClick={() => {
            setSent(false);
            setToken("");
            setMessage("");
          }}>이메일 다시 입력</button>
        </form>
      )}
      {message && <p role="status" className="form-message">{message}</p>}
    </div>
  );
}
