# Runbook: 새 버전 배포 / Deploy New Version

> **⚠️ v1 (legacy EC2).** This runbook targets the v1 single-EC2 app. For **v2** deploy with `make deploy` (arm64 → ECR → ECS rolling → `/api/health` smoke) — see root `CLAUDE.md`.

코드 변경사항을 운영 EC2에 안전하게 배포.
Safely deploy code changes to the production EC2 instance.

## 배포 시나리오 / Scenarios

### A. 프론트엔드/백엔드 코드만 변경 (일반)
Next.js 앱 코드 변경 — 가장 흔함.

```bash
# 1. 빌드
cd /home/ec2-user/awsops
npm run build 2>&1 | tail -30
# 성공하면 ".next" 디렉토리 갱신됨 / ".next" directory updates on success

# 2. 서버 재시작 (그레이스풀 kill → 즉시 재기동)
kill $(pgrep -f "next-server") && sleep 2
nohup npm run start > /tmp/awsops-server.log 2>&1 &

# 3. 검증
sleep 5
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/awsops/api/alert-webhook
# HTTP 200 이 나와야 함 / expect HTTP 200
```

### B. SQL 쿼리 파일만 변경
`src/lib/queries/*.ts` 변경은 빌드 불필요 (컴파일 후에도 즉시 반영 안 됨 → 빌드 필요).
Query file changes require a rebuild to take effect.

→ 시나리오 A 와 동일.

### C. AgentCore Agent 변경 (`agent/agent.py`)
Docker 재빌드 + ECR push 필요.

```bash
bash scripts/06a-setup-agentcore-runtime.sh
# 또는 수동:
cd /home/ec2-user/awsops/agent
docker buildx build --platform linux/arm64 -t <ECR>:latest --load .
docker push <ECR>:latest
aws bedrock-agentcore-control update-runtime --name awsops ...
```

### D. Lambda 변경 (`agent/lambda/*.py`)
```bash
bash scripts/06c-setup-agentcore-tools.sh
```

### E. CDK 인프라 변경
**주의**: EC2 교체 시 로컬 데이터 (캐시, 인벤토리 스냅샷) 초기화됨.
**Warning**: EC2 replacement wipes local cache/inventory snapshots.

```bash
cd /home/ec2-user/awsops/infra-cdk
npx cdk diff   # 변경 내역 확인 필수 / review diff first
npx cdk deploy
```

EC2 교체 후 / After EC2 replacement:
- `data/` 디렉토리는 S3/Git으로 백업된 것만 복원됨
- 리포트 메타는 S3 객체 리스트에서 재구성 (`data/reports/*.json`)
- Steampipe 캐시는 자연스럽게 재생성

## 체크리스트 / Checklist
- [ ] `npm run build` 성공
- [ ] 타입 에러 0건 (ESLint warning은 허용)
- [ ] `/awsops` 루트 200 응답
- [ ] `/awsops/api/alert-webhook` 200 응답
- [ ] 로그인 → 대시보드 렌더링 확인
- [ ] 최근 변경된 페이지 수동 확인

## 롤백 / Rollback
```bash
cd /home/ec2-user/awsops
git log --oneline -5                  # 이전 커밋 확인
git checkout <PREV_COMMIT> -- src/    # 소스만 되돌림
npm run build
kill $(pgrep -f "next-server") && sleep 2
nohup npm run start > /tmp/awsops-server.log 2>&1 &
```

## 문제 해결 / Troubleshooting

### 빌드 실패 (TypeScript)
- `src/lib/app-config.ts` 타입 정의가 실제 `data/config.json` 과 일치하는지
- 새 선택적 필드는 `?:` 로 표시

### 빌드 실패 (ESLint error)
Next.js 는 warning은 통과시키지만 error는 차단. 대표 케이스:
- unused variable → `_` 프리픽스 또는 제거
- 미참조 import → 제거

### 서버는 기동되었으나 500 에러
```bash
tail -100 /tmp/awsops-server.log
```
- `.env.local` 누락 (Cognito 변수)
- Steampipe 연결 실패 → `steampipe service status`

## 관련 파일 / Related Files
- `scripts/03-build-deploy.sh` — 통합 빌드 스크립트
- `scripts/09-start-all.sh`, `scripts/10-stop-all.sh`
- `scripts/11-verify.sh` — 전체 검증 (82 체크)
