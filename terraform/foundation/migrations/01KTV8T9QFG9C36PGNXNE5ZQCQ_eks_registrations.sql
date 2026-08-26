-- since: 2.0.0
-- eks_registrations — EKS runtime registration: clusters an admin registered for
-- in-app queries (the v2 equivalent of v1's "Register kubeconfig"; union'd with the
-- ONBOARDED_EKS_CLUSTERS env). Also written by the EventBridge auto-register Lambda.
-- Converted from the provisional integer "v11" block (legacy schema.sql path).
-- Live DB already has this table + rows: IF NOT EXISTS keeps this idempotent.
CREATE TABLE IF NOT EXISTS eks_registrations (
  cluster_name  TEXT PRIMARY KEY,
  registered_by TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
