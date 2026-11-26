# Feeding the AWSops presentation export

The report writer emits the current-architecture section in `scripts/v2/workers/diagnosis/architecture.py`. The browser's shared decoder in `web/lib/diagnosis-visuals.ts` and deck builder in `web/lib/diagnosis-deck.ts` turn those saved tables into HTML and native PowerPoint. The renderer reads the saved text. A standalone Draw.io file or a skill installed on the author's computer does not change the stored report.

When preparing a report edition, preserve the writer's localized architecture heading, three column headers, relationship labels and separators. The worker has Korean, English, Japanese and Chinese forms. Use a literal arrow only for a recorded call and a spaced slash for an association; wrap endpoint IDs containing delimiters in inline code. Place a short interpretation immediately before the table to carry it onto the slide. Keep source and material qualifiers in the third column. Use the client's own sources and report locale.

The following fictional excerpt illustrates the export grammar. All records belong to one report account. The two members have matching regional IDs and the same explicit VPC membership citation. The trace is independent and its equal display names retain distinct trace IDs.

```markdown
## 현재 아키텍처

### 결제 진입 계층의 배치

리스너 변경 전에는 이 배치와 현재 타깃 등록을 함께 대조하세요.

| 관계 유형 | 양 끝점 | 관측 근거와 범위 |
| --- | --- | --- |
| 구성 관계 | `ALB · payments` (us-west-2) / `vpc-12345678` (us-west-2) | AWS 구성 스냅샷 · infra:in_vpc · 2026-01-12 |
| 구성 관계 | `rtb-12345678` (us-west-2) / `vpc-12345678` (us-west-2) | AWS 구성 스냅샷 · infra:in_vpc · 2026-01-12 |

### 호출 표본에서 확인한 서비스

| 관계 유형 | 양 끝점 | 관측 근거와 범위 |
| --- | --- | --- |
| 호출 표본 | `payments (trace:21)` → `payments (trace:45)` | X-Ray · us-west-2 · 2026-01-12 10:00–10:05 UTC · 워크로드 연결 미확인 |
```

The current browser renderer draws a shared VPC boundary when at least two explicit membership rows agree on the regional VPC ID and the full source citation, including the worker's `infra:in_vpc` token. Copy that token only from an actual membership record. A single membership can appear as a neutral pair. Differing qualifiers stay with their rows. A report with only an inventory summary can use the writer-compatible boundary table (for example, `경계 | 확인된 구성 | 운영 판단`) with separate groups. Keep proposed actions in a separate section. The standalone diagram can use AWS service icons and a custom spatial layout; the browser supports the layouts in its decoder.
