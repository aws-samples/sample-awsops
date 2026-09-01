// Static mirror of the worker's diagnosis section catalog — for the in-progress checklist grid
// (gap L177) and the idle-state scope preview (gap L180). MANUAL LOCKSTEP with
// scripts/v2/workers/diagnosis/sections.py (SECTIONS / _DEEP_ONLY / INTENDED_VS_ACTUAL_SECTION
// keys+titles, and TITLES_I18N for the localized deep titles) — same convention as the other
// documented lockstep sites (web/lib/CLAUDE.md). Drift degrades honestly: the grid matches
// completed sections by TITLE STRING against every variant listed here, so an unknown title
// simply doesn't check a box — never a wrong check.

export interface DiagSection {
  key: string;
  /** Catalog title (what ko reports emit). */
  title: string;
  /** Localized render titles (non-ko reports emit these) — deep sections only. */
  variants?: string[];
  /** Deep-tier-only section. */
  deep?: boolean;
}

export const DIAG_SECTIONS: DiagSection[] = [
  { key: 'executive_summary', title: 'Executive Summary' },
  { key: 'security_posture', title: 'Security Posture' },
  { key: 'network_architecture', title: 'Network Architecture' },
  { key: 'compute_infrastructure', title: 'Compute Infrastructure' },
  { key: 'database_storage', title: 'Database & Storage' },
  { key: 'cost_overview', title: 'Cost Overview' },
  { key: 'recent_changes', title: 'Recent Changes' },
  { key: 'recommendations', title: 'Recommendations' },
  { key: 'identity_access', title: 'IAM & 자격 증명 심층', deep: true,
    variants: ['IAM & Identity Deep-Dive', 'IAM 与身份深度分析', 'IAM・アイデンティティ詳細'] },
  { key: 'data_protection', title: '데이터 보호 & 암호화', deep: true,
    variants: ['Data Protection & Encryption', '数据保护与加密', 'データ保護と暗号化'] },
  { key: 'network_exposure', title: '네트워크 보안 / 노출', deep: true,
    variants: ['Network Security / Exposure', '网络安全 / 暴露面', 'ネットワークセキュリティ / 露出'] },
  { key: 'reliability_ha', title: '신뢰성 & 고가용성', deep: true,
    variants: ['Reliability & High Availability', '可靠性与高可用', '信頼性と高可用性'] },
  { key: 'observability_coverage', title: '관측성 & 알람 커버리지', deep: true,
    variants: ['Observability & Alarm Coverage', '可观测性与告警覆盖', '可観測性とアラームカバレッジ'] },
  { key: 'external_obs_signals', title: '외부 관측성 신호 (Prometheus/Mimir)', deep: true,
    variants: ['External Observability Signals (Prometheus/Mimir)', '外部可观测性信号 (Prometheus/Mimir)', '外部可観測性シグナル (Prometheus/Mimir)'] },
  { key: 'cost_optimization', title: '비용 최적화 심층', deep: true,
    variants: ['Cost Optimization Deep-Dive', '成本优化深度分析', 'コスト最適化詳細'] },
  { key: 'intended_vs_actual', title: 'Intended vs Actual' },
];

/** The expected section list for a tier (light/mid = base 8 + intended; deep = all 16). */
export function sectionsForTier(tier: string): DiagSection[] {
  return tier === 'deep' ? DIAG_SECTIONS : DIAG_SECTIONS.filter((s) => !s.deep);
}

/** UI-language display title: variants are ordered [en, zh, ja]; ko (and base sections with
 *  no variants) use the catalog title. */
export function localizedTitle(section: DiagSection, lang: string): string {
  if (!section.variants) return section.title;
  const idx = lang === 'en' ? 0 : lang === 'zh' ? 1 : lang === 'ja' ? 2 : -1;
  return idx >= 0 ? (section.variants[idx] ?? section.title) : section.title;
}

/** True when a completed-progress title refers to this catalog entry (any language variant). */
export function titleMatches(section: DiagSection, completedTitle: string): boolean {
  return section.title === completedTitle || (section.variants ?? []).includes(completedTitle);
}
