-- since: 2.0.0
-- eks_registrations.auth — per-cluster auth override stored in Aurora (v1 "kubeconfig 등록" parity).
-- Shapes (JSONB):
--   {"mode":"sa-token","token":"<k8s ServiceAccount bearer>"}          — no AWS access entry needed
--   {"mode":"assume-role","roleArn":"arn:aws:iam::…","externalId":"…"} — presigned token via AssumeRole
--   NULL — default: web task-role presigned token (requires an EKS Access Entry, current behavior).
-- The token value is NEVER returned by read APIs (mode only); Aurora storage-encrypts at rest (KMS).
ALTER TABLE eks_registrations ADD COLUMN IF NOT EXISTS auth JSONB;
