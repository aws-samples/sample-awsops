# Isolated review image codec

## Purpose

Untrusted image bytes must not share the reviewer process's filesystem or network
privileges. This module prepares a dedicated decoder image and runs each decode as
UID/GID 65532, with no runner workspace or credential mounts, no network, a read-only
root filesystem, dropped capabilities and `no-new-privileges`.

The Python 3.12 base uses an immutable multi-architecture digest. Pillow 12.3.0 uses
the hash-pinned binary requirements. Only PNG, static WebP and single-rendition ICO
are decoded. Other registered formats remain unsupported. The decoder bounds bytes,
dimensions, pixels and frames; output is one JSON metadata line followed by PNG bytes.
PNG source bytes are retained after full decoding.

Each container has a 512 MiB memory limit, one CPU, 32 PIDs and a private 32 MiB tmpfs.
The decoder also applies address-space, CPU and descriptor rlimits. The host bounds
stdout, creates the stopped container within 15 seconds, and then allows 25 seconds
for decoding before killing its Docker client and removing
the named container. Docker availability or cleanup failures are explicit errors;
there is no direct host-decoding fallback.

## Verification

Docker is required. Prepare the immutable image once and point tests at its private
state file. The build context contains only the Dockerfile, decoder, format table
and binary requirements, never the full checkout.

```bash
codec_root=$(mktemp -d)
python3 scripts/pr-review/codec_sandbox.py prepare --state "$codec_root/state.json"
AWSOPS_REVIEW_CODEC_STATE="$codec_root/state.json" \
  python3 -m pytest scripts/v2/test_review_codec_sandbox.py -q
python3 scripts/pr-review/codec_sandbox.py cleanup --state "$codec_root/state.json"
rm -rf -- "$codec_root"
```

The tests inspect actual container UID, capabilities, privilege escalation status,
network interfaces and root mount flags. A host-only marker and host credential
canary must be invisible. Separate run labels prove cleanup does not remove another
run's container. Decoder tests use synthetic bytes and make no AWS/model calls.
Merge Verify performs this setup explicitly; missing sandbox coverage is not a pass.

## Integration and cleanup

The `prepare` command writes schema/version, immutable image ID, random run label
and owned tag to a new mode-0600 file. `load_state` rejects symlinks, special files,
oversized or malformed state. `decode` returns only bounded output and exit status;
the caller must still validate metadata, PNG bytes and source/render provenance.

Per-decode cleanup removes only the generated container name. Final cleanup selects
only the recorded run label and removes only its owned image tag. Runner loss can
prevent cleanup; those resources remain confined and labeled for operator inspection.
The image has no user-secret material. Docker's standard runtime files and private
tmpfs remain present; no runner checkout is mounted.

This standalone module does not wire the privileged PR review workflow. Its later
integration must build from trusted workflow source before credentials, use the
restricted decoder exclusively, preserve latest-HEAD coverage gates and run final
cleanup. Container isolation contains a compromised decoder's privileges; it is not
proof that every model perceived every pixel.

## Related files and ADRs

- `scripts/pr-review/codec_sandbox.py`
- `scripts/pr-review/codec.Dockerfile`
- `scripts/pr-review/render_head_image.py`
- `scripts/pr-review/image-formats.json`
- `scripts/pr-review/image-requirements.txt`
- `scripts/v2/test_review_codec_sandbox.py`
- `.github/workflows/merge-verify.yml`
- [Docker run security/resource options](https://docs.docker.com/engine/containers/run/)
- [Docker network-none behavior](https://docs.docker.com/engine/network/drivers/none/)

ADR-005 remains unchanged: this is local CI tooling, with no AWS resource mutation,
IAM change or new model tool grant.
