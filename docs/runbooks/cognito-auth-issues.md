# Runbook: Cognito 인증 문제 / Cognito Authentication Issues

로그인 실패, Lambda@Edge 검증 오류, 쿠키 문제 대응.
Login failures, Lambda@Edge validation errors, and cookie issues.

## 아키텍처 / Flow
```
Browser → CloudFront → Lambda@Edge (JWT verify, us-east-1)
                     → ALB → EC2 Next.js
```

`.env.local` 필수 변수 / Required env vars:
```
COGNITO_REGION=ap-northeast-2
COGNITO_USER_POOL_ID=ap-northeast-2_XXXXXXXX
COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxx
COGNITO_CLIENT_SECRET=xxxxxxxxxxxxxxxxxx
AWS_REGION=ap-northeast-2
```

`CLIENT_SECRET` 은 `InitiateAuth` 의 `SECRET_HASH` 계산에 필수.
`CLIENT_SECRET` is required for the `SECRET_HASH` parameter in `InitiateAuth`.

## 증상별 대응 / Symptoms

### 1. "Cognito not configured" 에러
`.env.local` 가 누락되었거나 변수가 비어있음.

```bash
grep -E 'COGNITO_|AWS_REGION' /home/ec2-user/awsops/.env.local
# 5개 변수가 모두 출력되어야 함 / all 5 should appear
```

수정 후 Next.js 재시작 필요 (env는 기동 시에만 읽음):
```bash
kill $(pgrep -f "next-server") && sleep 2
nohup npm run start > /tmp/awsops-server.log 2>&1 &
```

### 2. "Authentication failed" (잘못된 자격증명)
- Cognito 콘솔에서 사용자 상태 확인 (`CONFIRMED`인지)
- `USER_PASSWORD_AUTH` flow가 App Client 에서 활성화되었는지

### 3. Lambda@Edge JWT 검증 실패 (403)
CloudFront 레벨에서 차단되면 ALB까지 요청이 오지 않음.

```bash
# CloudFront 로그 확인 (S3) / CloudFront access logs
aws s3 ls s3://awsops-deploy-<ACCOUNT>/cloudfront-logs/ --recursive | tail -5

# Lambda@Edge 로그 — us-east-1 에 있음 (CloudFront viewer 지역별 복제)
aws logs tail "/aws/lambda/us-east-1.awsops-auth" --region us-east-1 --since 10m
```

원인 / Causes:
- JWKS 캐시 만료 (Lambda cold start 후 첫 요청 느림 — 정상)
- 새 Cognito Pool로 교체 후 Lambda@Edge 재배포 안 됨 → `scripts/08-setup-cloudfront-auth.sh`

### 4. 로그인 성공 후 루프 / Login loop
쿠키 도메인/경로 문제.

```bash
# 브라우저 devtools: Application → Cookies
# 확인 사항:
# - Domain: .<your-domain> (앞에 점)
# - Path: /
# - Secure: true
# - HttpOnly: true
# - SameSite: Lax
```

### 5. 로그아웃이 동작하지 않음 / Sign out does nothing
HttpOnly 쿠키는 `document.cookie`로 삭제 불가 → 서버 사이드 삭제 필요.

`POST /api/auth` 가 `Set-Cookie: ...; Max-Age=0` 를 리턴해야 함.
`POST /api/auth` must return `Set-Cookie` headers with `Max-Age=0`.

```bash
curl -v -X POST http://localhost:3000/awsops/api/auth 2>&1 | grep -i set-cookie
```

## 관련 파일 / Related Files
- `src/app/api/auth/route.ts` — 로그아웃 처리
- `src/lib/auth-utils.ts` — JWT payload 디코딩
- `src/app/login/page.tsx` — 로그인 UI
- `infra-cdk/lib/cognito-stack.ts` — Cognito + Lambda@Edge 정의
- `scripts/05-setup-cognito.sh`, `scripts/08-setup-cloudfront-auth.sh`

## 참고 / Reference
- Lambda@Edge는 반드시 `us-east-1` 에 배포되어야 CloudFront가 호출 가능
- Python 3.12 runtime 사용 (Node.js도 가능하나 현재 프로젝트는 Python)
