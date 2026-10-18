import Link from "next/link";

export default function QuickPage() {
  return (
    <section className="simple-page">
      <p className="eyebrow">간편 카운터</p>
      <h1>준비 중입니다</h1>
      <p>비로그인 카운터와 로컬 기록은 Phase 1에서 구현합니다. 지금은 카운트를 저장할 수 없습니다.</p>
      <Link className="text-link" href="/">홈으로 돌아가기</Link>
    </section>
  );
}
