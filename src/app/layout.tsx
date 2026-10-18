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
            <Link className="brand" href="/">StitchMori</Link>
            <span className="phase-label">Phase 1A</span>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
