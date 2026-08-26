import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import manifest from './manifest';

// PWA 3자 lockstep: manifest 아이콘 ↔ public/ 실제 파일 ↔ edge 공개 allowlist.
// iOS는 manifest·아이콘을 인증 쿠키 없이 fetch — allowlist 누락은 302 HTML로 조용히 깨진다.
describe('PWA manifest lockstep', () => {
  const m = manifest();
  const pub = path.join(__dirname, '..', 'public');
  const edgeSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'terraform', 'v2', 'foundation', 'edge-lambda', 'cognito_edge.py.tftpl'),
    'utf8',
  );

  it('설치 필수 필드 — standalone, 루트 스코프', () => {
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.name).toBe('AWSops');
  });

  it('manifest 아이콘이 public/에 실제로 존재하고 maskable 변형을 포함', () => {
    const icons = m.icons ?? [];
    expect(icons.length).toBeGreaterThanOrEqual(3);
    for (const i of icons) {
      expect(fs.existsSync(path.join(pub, i.src!.replace(/^\//, '')))).toBe(true);
    }
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(fs.existsSync(path.join(pub, 'apple-touch-icon.png'))).toBe(true);
  });

  it('manifest 자신·아이콘 전부가 edge 무인증 allowlist에 등록됨', () => {
    const publicPaths = ['/manifest.webmanifest', '/apple-touch-icon.png', ...(m.icons ?? []).map((i) => i.src!)];
    for (const p of publicPaths) expect(edgeSrc, `edge allowlist missing ${p}`).toContain(`'${p}'`);
  });

  it('layout이 apple-touch-icon과 appleWebApp 메타를 선언', () => {
    const layout = fs.readFileSync(path.join(__dirname, 'layout.tsx'), 'utf8');
    expect(layout).toContain("apple: '/apple-touch-icon.png'");
    expect(layout).toContain('appleWebApp');
    expect(layout).toContain("viewportFit: 'cover'");
  });
});
