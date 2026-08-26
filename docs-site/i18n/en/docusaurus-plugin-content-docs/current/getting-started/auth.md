---
sidebar_position: 5
title: Authentication Flow
description: Cognito authentication architecture and flow details
---

import AuthFlow from '@site/src/components/diagrams/AuthFlow';

# Authentication Flow

AWSops handles authentication using Amazon Cognito + Lambda@Edge + CloudFront.

<AuthFlow />

## Cognito Configuration

| Item | Setting |
|------|---------|
| **User Pool** | `awsops-user-pool` (self-signup disabled) |
| **Sign-in** | Email or username |
| **Password Policy** | 8+ characters, upper/lowercase + digits required |
| **OAuth** | Authorization Code Grant, OpenID/Email/Profile |
| **Token Validity** | 1 hour |
| **Login UI** | Custom login page (`/awsops/login`) — Cognito Hosted UI not used |
| **Auth flow** | `USER_PASSWORD_AUTH` (InitiateAuth) via `/api/auth` |

## Authentication Flow Details

### First Visit (No Cookie)

1. Browser navigates to `/awsops`
2. CloudFront triggers Lambda@Edge on viewer-request
3. Lambda@Edge checks for `awsops_token` cookie → not found/expired
4. **302 redirect to the custom login page `/awsops/login`** (not Cognito Hosted UI)
5. User enters email/password → `POST /awsops/api/auth` (`action: login`)
6. Server calls Cognito **InitiateAuth (`USER_PASSWORD_AUTH`)** → obtains IdToken
7. Sets `awsops_token` HttpOnly·Secure·SameSite=Lax cookie (1 hour)
8. Authenticated requests then flow through CloudFront → ALB → EC2

### Return Visit (Valid Cookie)

1. Browser sends request with `awsops_token` cookie
2. Lambda@Edge validates JWT → valid
3. Request passes through CloudFront → ALB → EC2

## Lambda@Edge

| Item | Setting |
|------|---------|
| **Region** | us-east-1 (required for Lambda@Edge) |
| **Runtime** | Python 3.12 (deployed handler; CDK stub is Node.js 20) |
| **Trigger** | CloudFront viewer-request |
| **Functions** | JWT validation, OAuth2 callback handling, cookie management |

:::warning Sign Out
HttpOnly cookies cannot be deleted via JavaScript (`document.cookie`). AWSops deletes cookies server-side via `POST /api/auth`.
:::

## Related Pages

- [Login](./login) - How to log in
- [Deployment Guide](./deployment) - Cognito deployment steps
- [Dashboard](../overview/dashboard) - System architecture overview
