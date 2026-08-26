"""WS-A — assert the diagnosis section catalog is Well-Architected-Deep-Dive depth (structure only;
LLM output quality is validated by the consensus gate + a live smoke, not unit tests)."""
from diagnosis import sections

# Collector result keys that exist in sources.collect_all (+ the synthetic intended_vs_actual). Sections
# must declare ONLY these — no new collectors / AWS APIs (the concurrent data branch owns the collectors).
VALID_SOURCES = {"inventory", "cw_metrics", "cost", "service_map", "datasources_obs", "posture",
                 "what_changed", "idle", "commitment"}
WADD = sections.DEEP_SECTIONS  # 8 base + 6 deep-only


def test_catalog_shape_stable():
    assert len(sections.SECTIONS) == 8
    assert len(sections.DEEP_SECTIONS) == 15
    assert sections.INTENDED_VS_ACTUAL_SECTION["key"] == "intended_vs_actual"


def test_sections_declare_only_existing_collector_keys():
    for s in WADD:
        assert s["sources"], s["key"]
        assert set(s["sources"]) <= VALID_SOURCES, (s["key"], s["sources"])


def test_prompts_are_wadd_depth():
    # persona + prescribed table + severity + priority + effort + honesty + read-only framing on every WADD section
    for s in WADD:
        p = s["prompt"]
        assert "당신은" in p, s["key"]                                  # expert persona
        assert "|" in p, s["key"]                                       # prescribed markdown table
        assert "[Critical]" in p and "[Warning]" in p, s["key"]         # severity labels
        assert "P1/P2/P3" in p, s["key"]                                # priority
        assert "Low/Med/High" in p, s["key"]                            # effort
        assert "데이터 불가" in p, s["key"]                              # honest data-gap clause
        assert "권고만" in p, s["key"]                                   # read-only (no auto-change)


def test_pricing_is_heuristic_and_honest_in_cost_sections():
    for key in ("compute_infrastructure", "database_storage", "cost_overview", "cost_optimization"):
        p = next(s["prompt"] for s in WADD if s["key"] == key)
        assert "Graviton" in p and "gp3" in p, key          # pricing benchmark tokens
        assert "가격 데이터 없음" in p, key                   # honest when cost data is absent (not stale $)


def test_executive_summary_has_6_pillar_health_score():
    p = next(s["prompt"] for s in sections.SECTIONS if s["key"] == "executive_summary")
    assert "건강 점수" in p and "100" in p
    for pillar in ("운영 우수성", "보안", "신뢰성", "성능", "비용", "지속가능성"):
        assert pillar in p, pillar
    assert "데이터 부족" in p  # data-less pillar (sustainability) is marked, not fabricated


def test_recommendations_has_quick_short_medium_roadmap():
    p = next(s["prompt"] for s in sections.SECTIONS if s["key"] == "recommendations")
    assert "Quick Wins" in p and "단기" in p and "중기" in p
    assert "우선순위 매트릭스" in p
    assert "절감" in p


def test_all_six_pillars_have_a_section_or_proxy():
    pillar_to_keys = {
        "operational_excellence": ["recent_changes", "observability_coverage"],
        "security": ["security_posture", "identity_access", "data_protection", "network_exposure"],
        "reliability": ["reliability_ha", "network_architecture"],
        "performance": ["compute_infrastructure"],
        "cost": ["cost_overview", "cost_optimization"],
        # sustainability has no native v2 signal → covered as a proxy/data-gap in the exec health score
    }
    keys = {s["key"] for s in WADD}
    for pillar, secs in pillar_to_keys.items():
        assert any(k in keys for k in secs), pillar


def test_external_obs_signals_section_present():
    s = next((x for x in sections.DEEP_SECTIONS if x["key"] == "external_obs_signals"), None)
    assert s is not None, "external_obs_signals section must exist"
    assert s["sources"] == ["datasources_obs"]
