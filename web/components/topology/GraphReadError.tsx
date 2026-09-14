'use client';

import Link from 'next/link';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { GraphFetchFailure } from '@/lib/graph-fetch';

const COPY = {
  en: { unauthenticated: 'Session expired. Sign in to read this graph.', forbidden: 'Access denied for this graph.', rejected: 'Graph request rejected. Check the selected account or resource.', signIn: 'Sign in' },
  ko: { unauthenticated: '세션이 만료되었습니다. 그래프를 보려면 로그인하세요.', forbidden: '이 그래프에 대한 접근이 거부되었습니다.', rejected: '그래프 요청이 거부되었습니다. 선택한 계정 또는 리소스를 확인하세요.', signIn: '로그인' },
  ja: { unauthenticated: 'セッションの有効期限が切れました。グラフを見るにはログインしてください。', forbidden: 'このグラフへのアクセスが拒否されました。', rejected: 'グラフ要求が拒否されました。選択したアカウントまたはリソースを確認してください。', signIn: 'ログイン' },
  zh: { unauthenticated: '会话已过期。请登录以查看此图。', forbidden: '无权访问此图。', rejected: '图请求被拒绝。请检查所选账号或资源。', signIn: '登录' },
};

export default function GraphReadError({ reason }: { reason: GraphFetchFailure }) {
  const { lang } = useI18n();
  const copy = COPY[lang];
  return <span role="alert" className="text-red-600">{copy[reason]}{reason === 'unauthenticated'
    ? <> <Link className="underline" href="/login">{copy.signIn}</Link></> : null}</span>;
}
