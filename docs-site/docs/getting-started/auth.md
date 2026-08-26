---
sidebar_position: 5
title: 인증 흐름
description: Cognito 인증 아키텍처 및 흐름 상세
---

import AuthFlow from '@site/src/components/diagrams/AuthFlow';

# 인증 흐름

AWSops는 Amazon Cognito + Lambda@Edge + CloudFront 조합으로 인증을 처리합니다.

<AuthFlow />

## Cognito 구성

| 항목 | 설정 |
|------|------|
| **User Pool** | `awsops-user-pool` (셀프 사인업 비활성화) |
| **로그인 방식** | 이메일 또는 사용자명 |
| **비밀번호 정책** | 8자 이상, 대/소문자 + 숫자 필수 |
| **OAuth** | Authorization Code Grant, OpenID/Email/Profile |
| **토큰 유효기간** | 1시간 |
| **로그인 UI** | 커스텀 로그인 페이지 (`/awsops/login`) — Cognito Hosted UI 미사용 |
| **인증 플로우** | `USER_PASSWORD_AUTH` (InitiateAuth) via `/api/auth` |

## 인증 흐름 상세

### 최초 방문 (쿠키 없음)

1. 브라우저가 `/awsops`에 접속
2. CloudFront가 viewer-request 이벤트로 Lambda@Edge 호출
3. Lambda@Edge가 `awsops_token` 쿠키 확인 → 없음/만료
4. **커스텀 로그인 페이지 `/awsops/login`으로 302 리다이렉트** (Cognito Hosted UI 아님)
5. 사용자가 이메일/비밀번호 입력 → `POST /awsops/api/auth` (`action: login`)
6. 서버가 Cognito **InitiateAuth (`USER_PASSWORD_AUTH`)** 호출 → IdToken 획득
7. `awsops_token` HttpOnly·Secure·SameSite=Lax 쿠키 설정 (1시간)
8. 이후 인증된 요청이 CloudFront → ALB → EC2로 전달

### 재방문 (유효한 쿠키)

1. 브라우저가 `awsops_token` 쿠키와 함께 접속
2. Lambda@Edge가 JWT 검증 → 유효
3. 요청이 그대로 CloudFront → ALB → EC2로 전달

## Lambda@Edge

| 항목 | 설정 |
|------|------|
| **리전** | us-east-1 (Lambda@Edge 필수) |
| **런타임** | Python 3.12 (배포 핸들러; CDK 스텁은 Node.js 20) |
| **트리거** | CloudFront viewer-request |
| **기능** | `awsops_token` JWT 쿠키 검증, 미인증 시 `/awsops/login` 리다이렉트 |

:::warning 로그아웃
HttpOnly 쿠키는 JavaScript(`document.cookie`)로 삭제할 수 없습니다. AWSops는 `POST /api/auth`를 통해 서버 사이드에서 쿠키를 삭제합니다.
:::

## 관련 페이지

- [로그인](./login) - 로그인 방법
- [배포 가이드](./deployment) - Cognito 배포 단계
- [대시보드](../overview/dashboard) - 시스템 아키텍처 개요
