#!/usr/bin/env bash
# 공용 헬퍼: 슬롯 디렉터리, 스킵 로깅, 크리덴셜 스크럽.
set -uo pipefail

# slot 디렉터리 보장 — 비-ephemeral 러너에서 $WORK 가 재사용될 수 있으므로, 이전 실행의
# 셀 파일이 남아 새 실행의 체어 입력에 섞이지 않도록 매번 비우고 새로 만든다. `rm -rf
# "$1/slot"`처럼 파괴적 경로를 만드는 함수라 빈 인자를 자기 안에서 가드.
ensure_slots() {
  [ -n "$1" ] || { echo "ensure_slots: \$1(workdir) must not be empty" >&2; return 1; }
  rm -rf "$1/slot"; mkdir -p "$1/slot"
}

# 한 패널 실행 결과를 평가해 responded 에 기록.
#   $1 슬롯 파일 경로, $2 패널 라벨, $3 responded 파일
# non-empty 체크만으로는 "응답함"이 실제 리뷰인지 보일러플레이트/거부 응답인지 구분이 안 되고,
# 그 원문은 어디에도 로깅되지 않아 사후 조사가 불가능했다(2026-07 감사: 샘플 18개 PR 중 17개에서
# CHAIR 가 "일부 패널이 diff 를 못 받았다"고 사후 진단했지만 원인 텍스트는 로그에 없었음).
# 성공/실패 무관하게 앞부분을 항상 찍어 다음번엔 CI 로그만으로 실제 내용을 바로 확인할 수 있게 한다.
# 프리뷰도 scrub_secrets 를 거친다 — 이 CI 로그를 볼 수 있는 사람 범위가 셀 출력을 볼 수 있는
# 사람 범위보다 넓을 수 있으므로, 원시 200B 를 그대로 찍으면 별도의 스크럽 없는 유출구가 된다.
record_result() {
  local slot="$1" label="$2" responded="$3"
  echo "[preview] $label: $(scrub_secrets < "$slot" | head -c 200 | tr '\n' ' ')" >&2
  if [ -s "$slot" ]; then
    echo "$label" >> "$responded"
  else
    echo "[skip] $label" >&2
    : > "$slot"  # 빈 슬롯 보장
  fi
}

# 자격증명 패턴 스크럽 — 마지막 방어선(last line of defense), 예방이 아님. Kiro 는 이 repo에서
# read/grep/fs_read 로 base 체크아웃 전체를 읽을 수 있어(BASE CONTEXT 검증 목적, 의도된 동작),
# diff 인젝션이 절대경로/레포 밖 크리덴셜을 읽게 유도하면 셀 출력에 그 값이 노출될 잔여 위험이
# 있다. 셀 출력을 체어에 넘기기 전 흔한 크리덴셜 포맷을 정규식으로 치환한다. 패턴은 co-agent 의
# `consensus_hooks.py::_SECRET_RE`(AWS/GitHub/Slack/OpenAI·Anthropic/Google + generic
# key=value)를 재사용하고, EKS Pod Identity 토큰(JWT 포맷) 탐지를 추가했다. 절대경로 read 자체를
# 막지는 못하므로(스크럽은 값이 셀 출력에 실제로 나타난 *뒤*에만 작동) 잔여 위험은 그대로 남는다.
scrub_secrets() {
  # PEM 은 여러 줄에 걸치므로 line-oriented sed 로는 본문을 못 지운다(헤더 줄만 매칭)
  # — awk 상태기계로 BEGIN..END 블록 전체를 마커 한 줄로 치환(첫 스테이지, 구조적 스크럽).
  awk '
    BEGIN { skip = 0 }
    /^-----BEGIN [A-Z ]*PRIVATE KEY-----/ { print "[REDACTED-PRIVATE-KEY]"; skip = 1; next }
    skip && /^-----END [A-Z ]*PRIVATE KEY-----/ { skip = 0; next }
    skip { next }
    { print }
    END { if (skip) print "[REDACTED-UNTERMINATED-PEM-BLOCK]" }
  ' | sed -E \
    -e 's/A(KIA|SIA)[0-9A-Z]{16}/[REDACTED-AWS-KEY]/g' \
    -e 's/gh[pousr]_[A-Za-z0-9]{30,}/[REDACTED-GH-TOKEN]/g' \
    -e 's/github_pat_[A-Za-z0-9_]{30,}/[REDACTED-GH-TOKEN]/g' \
    -e 's/xox[abprs]-[A-Za-z0-9-]{10,}/[REDACTED-SLACK-TOKEN]/g' \
    -e 's/(^|[^A-Za-z0-9_])sk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/\1[REDACTED-API-KEY]/g' \
    -e 's/AIza[0-9A-Za-z_-]{30,}/[REDACTED-GOOGLE-KEY]/g' \
    -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/[REDACTED-JWT]/g' \
    -e 's/(AUTHORIZATION:[[:space:]]*(basic|bearer)[[:space:]]+)[A-Za-z0-9+\/=_.~-]{20,}/\1[REDACTED-GIT-CRED-HEADER]/gI' \
    -e 's/((api[_-]?key|aws_secret_access_key|aws_access_key_id|access[_-]?token|client[_-]?secret|secret|passwd|password|token)['"'"'"]?[[:space:]]*[:=][[:space:]]*['"'"'"])[^'"'"'"]{8,}(['"'"'"])/\1[REDACTED]\3/gI' \
    -e 's/((^|[^A-Za-z0-9_])(api[_-]?key|aws_secret_access_key|aws_access_key_id|access[_-]?token|client[_-]?secret|secret|passwd|password|token)[[:space:]]*[:=][[:space:]]*)[A-Za-z0-9/+_-]{16,}/\1[REDACTED]/gI'
}
