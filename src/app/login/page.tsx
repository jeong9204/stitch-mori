import Link from "next/link";
import { EmailOtpForm } from "@/components/email-otp-form";
import { hasSupabaseEnv } from "@/lib/supabase/env";

export default function LoginPage() {
  return (
    <section className="simple-page auth-page">
      <p className="eyebrow">계정</p>
      <h1>이메일로 로그인</h1>
      <p>이메일로 받은 인증 코드 6자리를 입력하세요.</p>
      {hasSupabaseEnv() ? (
        <EmailOtpForm />
      ) : (
        <p className="notice" role="status">Supabase 환경변수가 설정되면 이메일 로그인을 이용할 수 있습니다.</p>
      )}
      <Link className="text-link" href="/">홈으로 돌아가기</Link>
    </section>
  );
}
