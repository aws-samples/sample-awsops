"""parse_event unit tests — the pure routing logic of the auto-register Lambda."""
from auto_register import parse_event

ROLE = "awsops-v2-task"


ADMIN_VIEW = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy"


def ev(name, params, error=None):
    d = {"eventName": name, "requestParameters": params}
    if error:
        d["errorCode"] = error
    return {"detail": d}


def test_associate_for_our_role_registers():
    action, cluster = parse_event(
        ev("AssociateAccessPolicy", {"name": "mall-apne2-az-a", "principalArn": "arn:aws:iam::1:role/awsops-v2-task", "policyArn": ADMIN_VIEW}),
        ROLE,
    )
    assert (action, cluster) == ("register", "mall-apne2-az-a")


def test_url_encoded_principal_is_decoded():
    action, cluster = parse_event(
        ev("AssociateAccessPolicy", {"name": "c1", "principalArn": "arn%3Aaws%3Aiam%3A%3A1%3Arole%2Fawsops-v2-task", "policyArn": ADMIN_VIEW}),
        ROLE,
    )
    assert action == "register"


def test_other_principal_is_ignored():
    action, reason = parse_event(
        ev("AssociateAccessPolicy", {"name": "c1", "principalArn": "arn:aws:iam::1:role/some-other-role"}),
        ROLE,
    )
    assert action is None
    assert "not awsops-v2-task" in reason


def test_delete_access_entry_unregisters():
    action, cluster = parse_event(
        ev("DeleteAccessEntry", {"name": "c1", "principalArn": "arn:aws:iam::1:role/awsops-v2-task"}),
        ROLE,
    )
    assert (action, cluster) == ("unregister", "c1")


def test_errored_call_is_skipped():
    action, reason = parse_event(
        ev("AssociateAccessPolicy", {"name": "c1", "principalArn": "arn:aws:iam::1:role/awsops-v2-task", "policyArn": ADMIN_VIEW},
           error="AccessDenied"),
        ROLE,
    )
    assert action is None
    assert "errored" in reason


def test_missing_cluster_is_skipped():
    action, reason = parse_event(ev("AssociateAccessPolicy", {"principalArn": "arn:aws:iam::1:role/awsops-v2-task", "policyArn": ADMIN_VIEW}), ROLE)
    assert action is None


def test_unhandled_event_is_skipped():
    action, reason = parse_event(
        ev("CreateAccessEntry", {"name": "c1", "principalArn": "arn:aws:iam::1:role/awsops-v2-task"}),
        ROLE,
    )
    assert action is None  # entry alone isn't queryable yet — we register on policy association


def test_ssl_context_requires_verification():
    """PR #36 MAJOR: the Aurora write-path must verify TLS (CERT_REQUIRED + hostname)."""
    import ssl
    from auto_register import _ssl_context
    ctx = _ssl_context()
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname is True


def test_creds_cache_ttl_and_force_refresh(monkeypatch):
    """PR #36 r3: a warm container must not serve a rotated-out secret forever."""
    import sys, types, json as _json
    import auto_register as ar

    calls = {"n": 0}

    class FakeSM:
        def get_secret_value(self, SecretId):
            calls["n"] += 1
            return {"SecretString": _json.dumps({"username": "u", "password": f"p{calls['n']}"})}

    fake_boto3 = types.SimpleNamespace(client=lambda *a, **k: FakeSM())
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)
    monkeypatch.setenv("AURORA_SECRET_ARN", "arn:test")
    ar._secret_cache.clear()

    t = {"now": 1000.0}
    monkeypatch.setattr(ar.time, "monotonic", lambda: t["now"])

    assert ar._creds()["password"] == "p1"
    assert ar._creds()["password"] == "p1"          # within TTL → cached
    assert calls["n"] == 1
    t["now"] += ar._SECRET_TTL_S + 1
    assert ar._creds()["password"] == "p2"          # TTL expired → re-fetched
    assert ar._creds(force_refresh=True)["password"] == "p3"  # rotation retry path
    assert calls["n"] == 3


def test_non_view_policy_association_is_rejected():
    """PR #36 r4: a mutating-capable policy association must NOT auto-register (ADR-029 read-only)."""
    action, reason = parse_event(
        ev("AssociateAccessPolicy", {"name": "c1", "principalArn": "arn:aws:iam::1:role/awsops-v2-task",
           "policyArn": "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"}),
        ROLE,
    )
    assert action is None
    assert "not a read-only view policy" in reason


def test_view_policy_also_registers():
    action, cluster = parse_event(
        ev("AssociateAccessPolicy", {"name": "c1", "principalArn": "arn:aws:iam::1:role/awsops-v2-task",
           "policyArn": "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"}),
        ROLE,
    )
    assert (action, cluster) == ("register", "c1")


def test_foreign_event_source_is_rejected():
    """PR #36 r5: defense-in-depth — only aws.eks events may act (rule already filters)."""
    e = ev("AssociateAccessPolicy", {"name": "c1", "principalArn": "arn:aws:iam::1:role/awsops-v2-task", "policyArn": ADMIN_VIEW})
    e["source"] = "aws.ec2"
    action, reason = parse_event(e, ROLE)
    assert action is None
    assert "unexpected event source" in reason


def test_malformed_cluster_name_is_rejected():
    """PR #36 r5: TEXT PK must not accept names outside the EKS charset."""
    action, reason = parse_event(
        ev("AssociateAccessPolicy", {"name": "bad/../name", "principalArn": "arn:aws:iam::1:role/awsops-v2-task", "policyArn": ADMIN_VIEW}),
        ROLE,
    )
    assert action is None
    assert "invalid cluster name" in reason


def test_explicit_aws_eks_source_is_accepted():
    """Panel r6 (kiro): lock the contract — an explicit aws.eks source must pass the guard."""
    e = ev("AssociateAccessPolicy", {"name": "c1", "principalArn": "arn:aws:iam::1:role/awsops-v2-task", "policyArn": ADMIN_VIEW})
    e["source"] = "aws.eks"
    assert parse_event(e, ROLE) == ("register", "c1")


def test_cluster_name_length_cap():
    """Panel r6 (kiro): 100 chars passes, 101 rejects ({0,99} after the first char)."""
    ok = "a" * 100
    too_long = "a" * 101
    assert parse_event(ev("AssociateAccessPolicy", {"name": ok, "principalArn": "arn:aws:iam::1:role/awsops-v2-task", "policyArn": ADMIN_VIEW}), ROLE)[0] == "register"
    assert parse_event(ev("AssociateAccessPolicy", {"name": too_long, "principalArn": "arn:aws:iam::1:role/awsops-v2-task", "policyArn": ADMIN_VIEW}), ROLE)[0] is None
