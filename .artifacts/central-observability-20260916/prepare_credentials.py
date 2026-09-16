#!/usr/bin/env python3
"""Create private telemetry PKI; keep secrets out of manifests and command output."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess

from build import ROUTES, CENTRAL, AGENTS

TMP = Path("/tmp/awsops-central-telemetry.bOV102")
PKI = TMP / "pki"
KUBE = TMP / "kubeconfig"
AWS = ["aws", "--profile", "samples-atomoh", "--region", "ap-northeast-2"]


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def kube(cluster, args, **kwargs):
    return run(["kubectl", "--kubeconfig", str(KUBE), "--context", cluster] + args, **kwargs)


def store(name, values):
    body = PKI / (name.rsplit("/", 1)[-1] + ".vault.json")
    body.write_text(json.dumps(values))
    result = subprocess.run(AWS + ["secretsmanager", "describe-secret", "--secret-id", name],
                            capture_output=True)
    if result.returncode:
        if b"ResourceNotFoundException" not in result.stderr:
            raise RuntimeError(result.stderr.decode())
        run(AWS + ["secretsmanager", "create-secret", "--name", name,
                   "--secret-string", f"file://{body}", "--tags", "Key=Project,Value=central-observability"])
    else:
        run(AWS + ["secretsmanager", "put-secret-value", "--secret-id", name,
                   "--secret-string", f"file://{body}"])


def retrieve(name):
    result = subprocess.run(AWS + ["secretsmanager", "get-secret-value", "--secret-id", name],
                            capture_output=True)
    if result.returncode:
        if b"ResourceNotFoundException" in result.stderr:
            return None
        raise RuntimeError(result.stderr.decode())
    return json.loads(json.loads(result.stdout)["SecretString"])


def ksecret(cluster, namespace, name, data):
    value = {"apiVersion": "v1", "kind": "Secret",
             "metadata": {"name": name, "namespace": namespace},
             "type": "Opaque", "data": {
                 k: base64.b64encode(v if isinstance(v, bytes) else v.encode()).decode()
                 for k, v in data.items()}}
    kube(cluster, ["apply", "-f", "-"], input=json.dumps(value).encode())


def certificate(name, server=False):
    key, cert = PKI / (name + ".key"), PKI / (name + ".crt")
    if cert.exists():
        return key, cert
    csr = PKI / (name + ".csr")
    ext = PKI / (name + ".ext")
    ext.write_text(
        "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n"
        + ("extendedKeyUsage=serverAuth\nsubjectAltName=DNS:telemetry-gateway,DNS:telemetry-gateway.central-observability.svc,DNS:telemetry.platform.internal\n"
           if server else "extendedKeyUsage=clientAuth\n")
    )
    run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
         "-out", str(csr), "-subj", "/CN=" + name])
    run(["openssl", "x509", "-req", "-in", str(csr), "-CA", str(PKI / "ca.crt"),
         "-CAkey", str(PKI / "ca.key"), "-CAcreateserial", "-out", str(cert),
         "-days", "365", "-sha256", "-extfile", str(ext)])
    return key, cert


def prepare():
    os.umask(0o077)
    identity = json.loads(run(AWS + ["sts", "get-caller-identity"]))
    assert identity["Account"] == "061525506239"
    assert identity["Arn"].startswith("arn:aws:sts::061525506239:assumed-role/atomoh/")
    PKI.mkdir(exist_ok=True, mode=0o700)
    # Reuse the installed CA after a /tmp cleanup; never silently rotate trust.
    if not (PKI / "ca.crt").exists():
        existing = retrieve("/ops/central-observability/pki")
        if existing:
            allowed = {"ca.key", "ca.crt"}
            allowed.update(name + suffix for name in ["telemetry-gateway"] + list(ROUTES)
                           for suffix in (".key", ".crt"))
            for name, value in existing.items():
                assert name in allowed
                (PKI / name).write_text(value)
    if not (PKI / "ca.crt").exists():
        run(["openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256",
             "-keyout", str(PKI / "ca.key"), "-out", str(PKI / "ca.crt"),
             "-days", "1825", "-subj", "/CN=samples-central-telemetry-ca"])
    for name in ["telemetry-gateway"] + list(ROUTES):
        certificate(name, server=name == "telemetry-gateway")
    pw = PKI / "clickhouse-password"
    if not pw.exists():
        existing = retrieve("/ops/central-observability/clickhouse")
        pw.write_text(existing["password"] if existing else secrets.token_hex(32))
    password = pw.read_text()
    digest = hashlib.sha256(password.encode()).hexdigest()
    users = (
        "<clickhouse><users><default remove=\"1\"/><telemetry>"
        f"<password_sha256_hex>{digest}</password_sha256_hex>"
        "<networks><ip>10.90.0.0/16</ip><ip>127.0.0.1</ip></networks>"
        "<profile>default</profile><quota>default</quota>"
        "<access_management>0</access_management>"
        "</telemetry></users></clickhouse>"
    )
    (PKI / "users.xml").write_text(users)
    store("/ops/central-observability/pki", {
        p.name: p.read_text() for p in PKI.iterdir() if p.suffix in (".key", ".crt")
    })
    store("/ops/central-observability/clickhouse", {"username": "telemetry", "password": password})
    kube("platform-cluster", ["apply", "-f", "-"],
         input=json.dumps({"apiVersion": "v1", "kind": "Namespace",
                           "metadata": {"name": CENTRAL}}).encode())
    ksecret("platform-cluster", CENTRAL, "telemetry-server-tls", {
        "tls.crt": (PKI / "telemetry-gateway.crt").read_bytes(),
        "tls.key": (PKI / "telemetry-gateway.key").read_bytes(),
        "ca.crt": (PKI / "ca.crt").read_bytes(),
    })
    ksecret("platform-cluster", CENTRAL, "clickhouse-auth", {"password": password, "users.xml": users})
    print("PKI and ClickHouse credentials stored in Secrets Manager; central mounted Secrets prepared.")


def client(cluster):
    os.umask(0o077)
    assert cluster in ROUTES
    kube(cluster, ["apply", "-f", "-"],
         input=json.dumps({"apiVersion": "v1", "kind": "Namespace",
                           "metadata": {"name": AGENTS}}).encode())
    ksecret(cluster, AGENTS, "telemetry-client-tls", {
        "tls.crt": (PKI / (cluster + ".crt")).read_bytes(),
        "tls.key": (PKI / (cluster + ".key")).read_bytes(),
        "ca.crt": (PKI / "ca.crt").read_bytes(),
    })
    print(cluster + ": client TLS Secret prepared.")


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 2:
        client(sys.argv[1])
    else:
        prepare()
