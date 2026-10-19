import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "StitchMori",
  description: "한 코씩 쌓이는 나의 뜨개 이야기",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <div className="shell">
          <header className="site-header">
            <Link className="brand" href="/" aria-label="StitchMori 홈">
              <span className="brand-name">StitchMori<span className="brand-mark" aria-hidden="true">✳</span></span>
              <span className="brand-tagline">한 코씩 쌓이는 나의 뜨개 이야기</span>
            </Link>
            <nav className="site-nav" aria-label="주요 메뉴">
              <Link href="/quick">간편 카운터</Link>
              <Link href="/login">로그인</Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
