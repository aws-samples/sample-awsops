# Docker Hub AND ghcr turbot/steampipe are frozen at 0.22.0 (last published 2024-03; the
# Steampipe/Powerpipe/Tailpipe split ended container publishing). 0.22.0's built-in plugin
# registry endpoint (us-docker.pkg.dev) now returns 403 for unauthenticated pulls, so the bare
# `steampipe plugin install aws` fails. Workaround: install the aws plugin from its new ghcr home
# via a full OCI ref, then relocate it to the hub.steampipe.io/... path the connection resolver
# expects (a short-name connection resolves to hub.steampipe.io/plugins/turbot/aws@<ver>), and
# rewrite versions.json so `steampipe plugin list` sees it installed under that canonical name.
# aws plugin uses 0.x versioning (no 1.x); 0.142.0 (plugin-sdk v5.10.0) is protocol-compatible with
# steampipe 0.22.0 (plugin-sdk v5.9.0) — the gRPC protocol stayed at 20 across SDK v5. Pinned = deterministic schema.
FROM turbot/steampipe:0.22.0
RUN steampipe plugin install "ghcr.io/turbot/steampipe/plugins/turbot/aws:0.142.0" \
 && P=/home/steampipe/.steampipe/plugins \
 && mkdir -p "$P/hub.steampipe.io/plugins/turbot" \
 && cp -a "$P/ghcr.io/turbot/steampipe/plugins/turbot/aws@0.142.0" "$P/hub.steampipe.io/plugins/turbot/aws@0.142.0" \
 && sed -i 's#ghcr.io/turbot/steampipe/plugins/turbot/aws#hub.steampipe.io/plugins/turbot/aws#g' "$P/versions.json" \
 && rm -rf "$P/ghcr.io"
# Boot-time aws.spc generator: query Aurora (accounts ⋈ account_regions / all_regions) → render a
# per-account/region connection config + aggregator, then supervise `steampipe service start`.
# Needs python3 + pg8000 (Aurora connection) + boto3 (rds.generate_db_auth_token — IAM database
# auth as the least-privilege steampipe_reader role; M1 — no Aurora secret is ever used).
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && (pip3 install --no-cache-dir --break-system-packages pg8000==1.31.2 boto3==1.34.162 \
     || pip3 install --no-cache-dir pg8000==1.31.2 boto3==1.34.162) \
 && rm -rf /var/lib/apt/lists/*
# RDS global CA truststore bundle (AWS's own published PEM, covers all regions): enables TLS
# VERIFY_FULL on the boot generator's Aurora connection instead of CERT_NONE (M3 fix). Fetched at
# build time — this image already requires network access at build (aws plugin from ghcr.io
# above), so this adds no new build-time constraint. World-readable: the entrypoint runs as the
# non-root `steampipe` user.
#
# Integrity check (F2): verify the download is a genuine, non-empty PEM bundle (starts with the
# PEM header, contains multiple certificates) rather than a truncated/corrupted response or an
# HTML error page silently written to the file. A hardcoded sha256 pin was deliberately NOT used
# here: AWS periodically rotates this bundle as CAs expire/renew, so a static hash would break
# every rebuild after the next rotation — a fail-loud content sanity-check is the safer trade-off.
RUN mkdir -p /app \
 && python3 -c "import urllib.request; urllib.request.urlretrieve('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', '/app/rds-ca-bundle.pem')" \
 && python3 -c "\
d = open('/app/rds-ca-bundle.pem', 'rb').read(); \
assert d.startswith(b'-----BEGIN CERTIFICATE-----'), 'RDS CA bundle: missing PEM header — corrupt/truncated download'; \
assert d.count(b'-----BEGIN CERTIFICATE-----') >= 5, 'RDS CA bundle: too few certificates — corrupt/truncated download'; \
assert len(d) > 4096, 'RDS CA bundle: suspiciously small — corrupt/truncated download'" \
 && chmod 0644 /app/rds-ca-bundle.pem
COPY --chown=steampipe:0 spc_render.py gen_spc_entrypoint.py /app/
USER steampipe
EXPOSE 9193
# Entrypoint generates aws.spc from Aurora, then exec's `steampipe service start` (network listener
# so the in-VPC sync Lambda can reach it; password via env STEAMPIPE_DATABASE_PASSWORD).
ENTRYPOINT ["python3", "/app/gen_spc_entrypoint.py"]
