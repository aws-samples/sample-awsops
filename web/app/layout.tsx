import './globals.css';
import ShellGate from '@/components/shell/ShellGate';
import { LanguageProvider } from '@/components/shell/LanguageProvider';

import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'AWSops',
  // iOS 홈 화면 설치(PWA): 아이콘은 manifest가 아니라 apple-touch-icon에서 읽는다.
  // 주의: metadata.icons가 존재하면 Next는 파일 컨벤션(app/icon.svg) 링크를 병합하지
  // 않는다 — icon을 함께 명시하지 않으면 파비콘이 /favicon.ico 폴백(302 HTML)으로 깨진다.
  icons: { icon: { url: '/icon.svg', type: 'image/svg+xml' }, apple: '/apple-touch-icon.png' },
  appleWebApp: {
    capable: true,
    title: 'AWSops',
    // 'default' = 상태바가 콘텐츠 위 별도 영역(라이트 기본 테마와 안전).
    // black-translucent는 라이트 테마에서 흰 상태바 글자가 안 보여 배제.
    statusBarStyle: 'default',
  },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 노치/다이내믹 아일랜드 안전영역 인셋 활성화 — 가로모드 left/right는 MobileTopBar·
  // BottomTabBar·AppShell main의 env() 측면 패딩이, 세로 bottom은 BottomTabBar pb +
  // main의 pb calc 보정이 처리한다 (top 패딩은 statusBarStyle 'default'에선 0인 방어적 패딩).
  viewportFit: 'cover',
  themeColor: '#528DF8',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" data-theme="cobalt" suppressHydrationWarning>
      <head>
        {/* No-flash: set data-theme from localStorage before first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('awsops-theme');var c={cobalt:'#528DF8',teal:'#01A88D',dark:'#1A2026'};if(t==='cobalt'||t==='teal'||t==='dark'){document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name=theme-color]');if(m&&c[t])m.setAttribute('content',c[t]);}}catch(e){}})();",
          }}
        />
      </head>
      <body className="min-h-screen bg-paper text-ink-800 font-sans antialiased">
        <LanguageProvider>
          <ShellGate>{children}</ShellGate>
        </LanguageProvider>
      </body>
    </html>
  );
}
