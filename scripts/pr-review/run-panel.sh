#!/usr/bin/env bash
# lens×모델 매트릭스 병렬 fan-out. 인자: <diff> <lenses_dir> <workdir>
# lenses_dir 안의 각 *.txt 가 lens 하나(파일명 stem = lens 태그, 예: L2/L3/L4/L5) — 그 lens
# 전용 리뷰 프롬프트(자체 완결형: "이 lens만 봐"). 각 lens × 각 모델이 독립 에이전트 셀 하나
# (oh-my-cloud-skills 의 lens×model 매트릭스 설계 포팅).
#
# diff 전달은 codex/claude 둘 다 stdin(`< "$DIFF"`, 파일이라 TTY 아님 → no-hang)으로 그대로
# 읽는다. timeout 백스톱 + 비대화형 플래그로 멈춤 방지. 슬롯이 비면 최대 PANEL_RETRIES 회
# 재시도(codex의 gpt-5.6-sol/bedrock-mantle, claude API 등 transient 흡수). 매 시도마다 $DIFF
# 를 다시 연다. 모든 셀(모델 수 × lens 수)이 병렬(&+wait) — 벽시계 ≈ 최슬로우 셀 하나, 순차합 아님.
#
# PLATFORM NOTE (self-hosted-runner/samples 배포): 이 리포 원본(local main, mall-apne2-mgmt
# 플랫폼)은 패널에 Kiro CLI(kiro-cli, EKS Pod Identity 인접 인증)를 쓰지만, 이 배포가 도는
# ARC 러너 이미지(platform-runner, docker/runner/Dockerfile)에는 kiro-cli가 없고 그 인증 수단도
# 이 계정에 준비돼 있지 않다. 대신 Claude 를 패널의 두 번째 벤더로 추가(체어와는 다른 모델 —
# 체어 primary는 fable-5, 패널-claude는 opus-5)해 Codex+Claude 2벤더 교차확인을 유지한다.
# kiro-cli 인증이 준비되면 원본처럼 Kiro 를 되돌려도 되지만, 그때도 이 파일의 TOTAL_MODELS/
# degraded 집계 로직은 그대로 두고 모델 목록만 늘리면 된다.
set -uo pipefail
DIFF="$1"; LENSES_DIR="$2"; WORK="$3"
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/lib.sh"
ensure_slots "$WORK"
SLOT="$WORK/slot"; RESP="$WORK/responded.txt"; : > "$RESP"
# 비-ephemeral 러너에서 $WORK 가 재사용되면 이전 실행이 남긴 severe 플래그가 그대로
# 살아남아, 이번엔 모든 모델이 정상 응답해도 synthesize.sh 가 강제 FAIL 하게 된다 —
# responded.txt/degraded-models.txt 처럼 매 실행 시작 시 리셋.
rm -f "$WORK/coverage-severe.flag"
T="${PANEL_TIMEOUT:-300}"
RETRIES="${PANEL_RETRIES:-2}"

shopt -s nullglob
LENS_FILES=("$LENSES_DIR"/*.txt)
shopt -u nullglob
if [ "${#LENS_FILES[@]}" -eq 0 ]; then
  echo "run-panel.sh: no *.txt lens files found in $LENSES_DIR" >&2
  exit 1
fi

try_panel() {
  local slot="$1" err="$2"; shift 2
  local a
  for a in $(seq 1 "$RETRIES"); do
    "$@" > "$slot" 2>"$err" < "$DIFF" || true
    [ -s "$slot" ] && break
    [ "$a" -lt "$RETRIES" ] && echo "[retry $a/$RETRIES] $(basename "$slot" .md)" >&2
  done
}

for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  LENS_PROMPT="$(cat "$lens_file")"

  # Codex (Bedrock, config.toml). --skip-git-repo-check 필수. AWS_REGION 강제: gpt-5.6-sol
  # (bedrock-mantle)는 In-Region(us-east-1) 만 지원 — 잡 region 무관하게 고정.
  if command -v codex >/dev/null 2>&1; then
    ( try_panel "$SLOT/codex-$lens.md" "$SLOT/codex-$lens.err" \
        env AWS_REGION="${CODEX_AWS_REGION:-us-east-1}" AWS_DEFAULT_REGION="${CODEX_AWS_REGION:-us-east-1}" \
        timeout "$T" codex exec -s read-only --skip-git-repo-check "$LENS_PROMPT" ) &
  else echo "[skip] codex/$lens (binary absent)" >&2; : > "$SLOT/codex-$lens.md"; fi

  # Claude — 체어(fable-5)와는 다른 모델(opus-5)로 돌려 codex와 별개인 두 번째 벤더로 삼는다.
  # 체어의 run_chair()와 동일한 --strict-mcp-config/--allowedTools 안전장치(synthesize.sh 참조:
  # 깨진 MCP 인증이 세션 초기화에서 조용히 멈춰 CHAIR_TIMEOUT까지 행걸림 — 동일 위험이 패널
  # 셀에도 적용됨). 스크립트 자체는 codex와 동일하게 stdin(`< "$DIFF"`)으로 diff를 받는다.
  if command -v claude >/dev/null 2>&1; then
    ( try_panel "$SLOT/claude-$lens.md" "$SLOT/claude-$lens.err" \
        env ANTHROPIC_MODEL="${PANEL_CLAUDE_MODEL:-us.anthropic.claude-opus-5}" \
        timeout "$T" claude -p "$LENS_PROMPT" --output-format text \
        --strict-mcp-config --allowedTools "Read Grep Glob" ) &
  else echo "[skip] claude/$lens (binary absent)" >&2; : > "$SLOT/claude-$lens.md"; fi
done

wait

# 결과 집계
for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  record_result "$SLOT/codex-$lens.md" "codex/$lens" "$RESP"
  record_result "$SLOT/claude-$lens.md" "claude/$lens" "$RESP"
done
echo "Panel responded ($(wc -l < "$RESP") / $(( 2 * ${#LENS_FILES[@]} )) cells): $(tr '\n' ' ' < "$RESP")"

# 커버리지 floor — 모델 하나(플래그 무효화/바이너리 부재/전면 인증 실패 등)가 lens 전부에서
# 응답 없으면, 매트릭스가 조용히 그 모델 없이 축소된 채 VERDICT: PASS 로 이어질 수 있다.
# 모델별 row 가 완전히 비면 경고 + synthesize.sh 가 리뷰 본문에 명시하도록 파일로 전달.
# TOTAL_MODELS=2(codex, claude) — 둘 중 하나라도 전부 죽으면 교차확인 벤더가 0개 남으므로
# 아래 severe 임계값(TOTAL_MODELS-1=1)이 정확히 "어느 한쪽이라도 완전히 죽으면 FAIL"이 된다.
TOTAL_MODELS=2
: > "$WORK/degraded-models.txt"
for model_tag in codex claude; do
  row_count="$(grep -c "^${model_tag}/" "$RESP" 2>/dev/null)"
  if [ "${row_count:-0}" -eq 0 ]; then
    echo "::warning::model '$model_tag' produced zero responses across all ${#LENS_FILES[@]} lenses — coverage degraded" >&2
    echo "$model_tag" >> "$WORK/degraded-models.txt"
  fi
done

# 심각도 상향 — degraded 모델이 (전체-1)개 이상이면 살아남은 벤더가 최대 1개뿐이라, "매트릭스
# 자체가 lens당 교차확인"이라는 warn-only 의 전제가 성립하지 않는다. 이 경우만 severe 로
# 승격해 synthesize.sh 가 VERDICT 를 강제 FAIL 하도록 신호를 남긴다.
DEGRADED_COUNT=$(wc -l < "$WORK/degraded-models.txt")
if [ "$DEGRADED_COUNT" -ge "$((TOTAL_MODELS - 1))" ]; then
  echo "::error::coverage collapsed to ≤1 vendor ($DEGRADED_COUNT/$TOTAL_MODELS models degraded) — forcing VERDICT: FAIL, no cross-model check remains for any lens" >&2
  : > "$WORK/coverage-severe.flag"
fi

# lens 별 floor — 위 모델별 floor는 "이 모델이 모든 lens에서 죽었는가"만 본다. 반대로 한
# lens 전체(모든 모델)가 비어도 모델별 row 는 (다른 lens 응답 덕분에) 0 이 아닐 수 있어
# 위 체크를 통과한다 — 그 lens 는 아무도 리뷰하지 않았는데 매트릭스 상 정상으로 보인다.
# 모델-floor는 (전체-1)개 탈락까지 warn-only 인 반면 이건 즉시 severe인 이유: 모델 하나가
# 죽어도 그 lens 는 다른 모델들이 여전히 교차확인하지만, lens 하나가 완전히 비면 그 lens
# 는 어떤 벤더도 보지 않은 것이라 "교차확인 중 하나가 약해졌다"가 아니라 "교차확인 자체가
# 존재하지 않는다" — 완화할 대상(다른 모델의 응답)이 없어 warn-only 를 정당화할 수 없다.
: > "$WORK/degraded-lenses.txt"
for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  lens_count="$(grep -c "/${lens}$" "$RESP" 2>/dev/null)"
  if [ "${lens_count:-0}" -eq 0 ]; then
    echo "::warning::lens '$lens' produced zero responses across all models — this lens was not reviewed" >&2
    echo "$lens" >> "$WORK/degraded-lenses.txt"
    : > "$WORK/coverage-severe.flag"
  fi
done

# skip 원인 노출: 빈 슬롯인데 stderr 가 있으면 stderr 의 끝(실제 에러)을 로그에 찍는다.
# scrub_secrets 를 거쳐 원시 크리덴셜이 CI 로그로 새는 것을 막는다(record_result 의 [preview]
# 와 같은 방어선).
for e in "$SLOT"/*.err; do
  [ -s "$e" ] || continue
  b="$(basename "$e" .err)"
  [ -s "$SLOT/$b.md" ] && continue   # 응답 성공이면 건너뜀
  echo "--- [$b] skipped; stderr (last 25 lines, scrubbed) ---" >&2
  tail -25 "$e" | scrub_secrets >&2
done
