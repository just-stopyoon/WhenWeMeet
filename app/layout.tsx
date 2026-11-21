import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  icons: { icon: '/app-logo.png', apple: '/icons/apple-touch-icon.png' },
  manifest: '/manifest.webmanifest',
  title: '언제 만날래 · 우리 약속을 한곳에서',
  description: '친구들과 날짜와 지역을 정하고 가고 싶은 곳을 모아보세요.',
  other: { 'apple-mobile-web-app-title': '언제 만날래' },
};
// viewport-fit=cover lets env(safe-area-inset-bottom) report the real inset.
export const viewport: Viewport = {
  viewportFit: 'cover',
  themeColor: '#ffffff',
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
