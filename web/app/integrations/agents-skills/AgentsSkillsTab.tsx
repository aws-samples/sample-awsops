'use client';
import Link from 'next/link';
import Card from '@/components/ui/Card';

// Agents & Skills is the third category (distinct from Datasource and Connector). The full management
// surface (New Agent / New Skill / Agents / Skills / Agent Space) lives on the Custom Agents page;
// this tab routes there. (The Connectors section has been removed from that page — datasources are in
// the Datasources tab, Notion in the Connectors tab.)
export default function AgentsSkillsTab() {
  return (
    <Card className="p-5 space-y-3 max-w-2xl">
      <h3 className="text-sm font-semibold text-ink-800">Agents &amp; Skills</h3>
      <p className="text-[13px] text-ink-500">
        커스텀 에이전트, 스킬(재사용 가능한 지시문 + 도구 허용목록), Agent Space를 관리합니다.
        Skill은 Datasource·Connector와 별개 개념입니다 — 에이전트가 도구/커넥터를 <i>어떻게</i> 쓰는지를 정의합니다.
      </p>
      <Link href="/customization" className="inline-flex items-center text-[13px] font-medium text-brand-600 hover:underline">
        Custom Agents &amp; Skills 열기 →
      </Link>
    </Card>
  );
}
