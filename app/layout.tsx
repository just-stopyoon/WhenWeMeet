import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: '언제 만날래 · 우리 약속을 한곳에서',
  description: '친구들과 날짜와 지역을 정하고 가고 싶은 곳을 모아보세요.',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
