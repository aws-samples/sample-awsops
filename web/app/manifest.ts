import type { MetadataRoute } from 'next';

// PWA manifest — iOS/iPadOS 홈 화면 설치(Add to Home Screen) 대상.
// Next가 /manifest.webmanifest로 서빙 + <link rel="manifest"> 자동 주입.
// 주의: iOS는 manifest·아이콘을 인증 쿠키 없이 fetch한다 — 여기 나열된 경로와
// apple-touch-icon은 반드시 edge-lambda(cognito_edge.py.tftpl) 공개 allowlist에 있어야 한다
// (lockstep 검증: app/manifest.test.ts).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AWSops',
    short_name: 'AWSops',
    description: 'AWS operations dashboard',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F4F6F8', // :root --paper (기본 라이트) — iOS는 스플래시에 이 값을 쓰지 않음(apple-touch-startup-image 필요), Android용
    theme_color: '#528DF8', // cobalt --brand-500 (app/icon.svg 배경과 동일)
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
