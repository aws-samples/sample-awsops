#!/usr/bin/env bash
# verify-deck.sh — single source of truth for the awsops-intro.pptx CI gates.
# Called by BOTH .github/workflows/merge-verify.yml (pre-merge, static/) and
# deploy-guide.yml (pre-deploy, build/) so the two never drift.
#
# Usage: bash scripts/verify-deck.sh <path-to-deck.pptx>   (cwd = docs-site/)
#
# Gates, in order:
#   1. structure   — non-empty, PK zip magic, ppt/presentation.xml present,
#                    no macros/embedded objects, no symlink entries,
#                    entry-count (500) and uncompressed-size (50MB) caps
#   2. content     — sensitive-identifier scan over all XML/rels (theme excluded
#                    for panose false positives): two passes, raw XML and
#                    tags→empty (the latter concatenates split OOXML <a:t> runs);
#                    grep exit codes handled fail-closed (only exit 1 passes)
#   3. provenance  — rebuild from the reviewed generator (pptxgenjs, lockfile-
#                    pinned, deterministic) and require part-list equality +
#                    byte equality of every extracted part (only docProps/core.xml
#                    dcterms timestamps are stripped). ZIP entry timestamps are
#                    not comparable across builds, so container metadata is
#                    covered separately in gate 1: archive comment, central AND
#                    local extra/comment fields empty, no data descriptors, and
#                    local records must tile the file with zero gap bytes
#   4. rel targets — no TargetMode="External" relationships
#
# Gate-3 pre-flights (fail-closed, run before the rebuild):
#   - asset pin is SET EQUALITY: assets/ must contain exactly the pinned files
#     (an unpinned file fails, not just a mismatched pinned one)
#   - every addImage( must pass a NON-EMPTY altText on the same line —
#     pptxgenjs writes descr=altText||<absolute build path>, so a missing or
#     empty altText leaks the build-host path AND breaks cross-machine parity
#
# Known limits (documented in static/presentation/awsops-intro/README.md):
# embedded images are pixels grep cannot read — provenance pins them to the
# reviewed generator assets, and any asset change must come through code review.
set -euo pipefail

DECK="${1:?usage: verify-deck.sh <path-to-deck.pptx>}"

PATTERN='\b[0-9]{12}\b|arn:aws[a-z-]*:|(AKIA|ASIA)[0-9A-Z]{16}|PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}|[a-z]{2}-[a-z]+-[0-9]_[A-Za-z0-9]{9}|atomai\.click|\.amazonaws\.com|[a-z0-9]{13,14}\.cloudfront\.net|AWSops[A-Za-z]*Role|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com|\.internal\b|\b(vpc|sg|subnet|eni|i|vol|ami|snap)-[0-9a-f]{8,17}\b|\b10\.[0-9]+\.[0-9]+\.[0-9]+\b|/home/[a-z]|/root/|/runner/work/|\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+\b|\b192\.168\.[0-9]+\.[0-9]+\b'

fail() { echo "::error::$1"; exit 1; }

# scan_text <text> <label> — grep exit codes: 0=leak, 1=clean, >=2=scan error.
scan_text() {
  local rc=0
  grep -aqE "$PATTERN" <<<"$1" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then fail "sensitive identifier found in deck ($2)"; fi
  if [ "$rc" -ne 1 ]; then fail "deck content scan failed ($2, grep exit $rc)"; fi
}

# ── 1. structure ─────────────────────────────────────────────────────────────
test -s "$DECK" || fail "awsops-intro.pptx missing or empty"
[ "$(head -c 4 "$DECK" | od -An -tx1 | tr -d ' \n')" = "504b0304" ] || fail "not a valid zip/pptx container"
# capture listings into variables (no `! cmd | grep` pipelines — immune to a
# future `shell: bash` pipefail override turning SIGPIPE into a bypass)
PARTS=$(unzip -Z1 "$DECK") || fail "cannot list deck zip entries"
MODES=$(unzip -Z "$DECK") || fail "cannot stat deck zip entries"
grep -q '^ppt/presentation\.xml$' <<<"$PARTS" || fail "lacks ppt/presentation.xml — not a real pptx"
if grep -qE 'vbaProject\.bin|^ppt/embeddings/.' <<<"$PARTS"; then fail "deck contains macros or embedded objects"; fi
if grep -q '^l' <<<"$MODES"; then fail "deck zip contains symlink entries"; fi
[ "$(wc -l <<<"$PARTS")" -le 500 ] || fail "deck zip has an implausible number of entries"
TOTAL=$(unzip -l "$DECK" | tail -1 | awk '{print $1}')
[ "$TOTAL" -le 52428800 ] || fail "deck uncompressed size exceeds 50MB cap"
# ZIP container metadata is a payload side-channel the extracted-tree diff cannot
# see — require the archive comment and every entry's extra/comment to be empty.
# ZipInfo.extra reflects only the CENTRAL directory, so the LOCAL file headers are
# re-parsed raw: local extra fields must be empty, data descriptors are banned
# (pptxgenjs never emits them), and the local records must tile the file
# contiguously up to the central directory (no inter-record gap bytes).
python3 - "$DECK" <<'PY' || fail "deck zip carries container metadata (comment/extra/gap/descriptor side-channel)"
import struct, sys, zipfile
raw = open(sys.argv[1], "rb").read()
z = zipfile.ZipFile(sys.argv[1])
assert z.comment == b"", "archive comment present"
infos = sorted(z.infolist(), key=lambda i: i.header_offset)
pos = 0
for i in infos:
    assert not i.comment, f"entry comment: {i.filename}"
    assert not i.extra, f"central-directory extra field: {i.filename}"
    assert i.header_offset == pos, f"gap bytes before local record: {i.filename}"
    hdr = raw[pos:pos + 30]
    assert hdr[:4] == b"PK\x03\x04", f"bad local header magic: {i.filename}"
    (flags,) = struct.unpack("<H", hdr[6:8])
    assert not flags & 0x08, f"data descriptor (streamed entry): {i.filename}"
    nlen, elen = struct.unpack("<HH", hdr[26:30])
    assert elen == 0, f"local-header extra field: {i.filename}"
    pos += 30 + nlen + i.compress_size
eocd = raw.rfind(b"PK\x05\x06")
assert eocd != -1, "no EOCD record"
cd_size, cd_off = struct.unpack("<II", raw[eocd + 12:eocd + 20])
assert cd_off != 0xFFFFFFFF, "zip64 EOCD indirection"
assert pos == cd_off, "gap bytes between local records and central directory"
assert cd_off + cd_size == eocd, "gap bytes between central directory and EOCD"
# ban bytes appended after the End-of-Central-Directory record (overlay side-channel)
assert eocd + 22 + len(z.comment) == len(raw), "trailing bytes after EOCD"
PY

# ── 2. content scan ──────────────────────────────────────────────────────────
# NOTE: the theme/non-XML exclusions here are backstopped by gate 3 (provenance
# pins every part byte-for-byte to generator output) — do not relax gate 3
# independently of widening this scan.
XML=$(unzip -p "$DECK" '*.xml' '*.rels' -x 'ppt/theme/*') || fail "deck XML parts unreadable"
test -n "$XML" || fail "deck content scan extracted zero bytes"
scan_text "$XML" "raw XML"
# tags stripped to EMPTY so text split across OOXML <a:t> runs concatenates
scan_text "$(sed -E 's/<[^>]*>//g' <<<"$XML")" "tag-stripped / split-run"
# third pass on entity-decoded text — closes &#NN; / named-entity encodings that
# render correctly in PowerPoint but do not match the raw patterns
scan_text "$(python3 -c 'import sys,html; sys.stdout.write(html.unescape(sys.stdin.read()))' <<<"$XML" | sed -E 's/<[^>]*>//g')" "entity-decoded"

# ── 3+4. provenance parity + external targets ────────────────────────────────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# pre-flight: a missing dependency/asset must not masquerade as a tampered deck
node -e 'require("pptxgenjs")' 2>/dev/null || fail "pptxgenjs not installed — run npm ci in docs-site/ (lockfile-pinned)"
# every addImage must pass altText: pptxgenjs writes descr=altText||<absolute
# build path>, so a missing altText both leaks the build-host path into the
# published deck and breaks rebuild parity across machines (CI vs local)
ADDIMG_LINES=$(grep -n "addImage(" scripts/pptx/*.js) || fail "altText pre-flight found no addImage( lines — generator moved/renamed, update this check"
NO_ALT=$(printf '%s\n' "$ADDIMG_LINES" | grep -v "altText" || true)
[ -z "$NO_ALT" ] || { printf '%s\n' "$NO_ALT"; fail "addImage without altText — pptxgenjs would embed the absolute build path (breaks parity, leaks host path)"; }
EMPTY_ALT=$(grep -nE "altText: *(\"\"|'')" scripts/pptx/*.js || true)
[ -z "$EMPTY_ALT" ] || { printf '%s\n' "$EMPTY_ALT"; fail "empty altText — falls back to the absolute build path exactly like a missing one"; }

# pin every generator PNG asset (backgrounds · logos · icons, vendored from the
# AWS light template kit) to its reviewed hash — an asset swap must not be able
# to launder itself through the rebuild-parity check. This SUM list is the
# single source of truth (the deck README points here, not the other way).
SUM_LIST=$(cat <<'SUM'
e915f9afeca6dc0e07b16469be7c9e2c67bd6956d1c63635db3719e8a07b08d6  scripts/pptx/assets/ai_agent.png
5aa903c2e4e347bc37e572fd773868c76906e6e452f716a417fe4f99a010eef0  scripts/pptx/assets/aws_cloud.png
00af7a668f834da597dd5bd49f41b6642e644882abe9c6d7bde9c0e08395ebff  scripts/pptx/assets/aws_logo.png
c2f256e8757493520536ed9371af587399d8ab7dd1d1615b5ad435afd281906f  scripts/pptx/assets/aws_logo_white.png
00521bdb306a5a0361167bbbdb9e6b79384648a894a09adcdc7595d320fa6011  scripts/pptx/assets/browser_tool.png
294d1b2c54ad335f8c70e03299a9afc1f8d8a8fcd944a4f9ab7d99d78c63e446  scripts/pptx/assets/cloudwatch.png
69ddf68c59e5b3d8da62d3b2338088f26643efc4d630b538a00564f4b6e81716  scripts/pptx/assets/cover_glow.png
a8669b51d63cb5266f3896073959347fd2d0af2699728bb6918f98149f0ab4f3  scripts/pptx/assets/evaluations.png
8323ab12688d855c98b28d9ddfba3b2a2cf489456ae9bdc461a04c6fc0a89c54  scripts/pptx/assets/gateway.png
95d014ef6666df37a70b8bee68392fd0658f71b4f95255148ab2ac871475c053  scripts/pptx/assets/grad_pill.png
c412a29cd9d063f6e30c31d43483c5718ec4fbb87c525a64600d1cab5bbb7c26  scripts/pptx/assets/section_grad.png
SUM
)
# set equality, expected count derived from the SUM list itself (single source):
# every pinned file must match, and assets/ must contain nothing else (any type/depth)
PIN_COUNT=$(printf '%s\n' "$SUM_LIST" | wc -l)
ASSET_COUNT=$(find scripts/pptx/assets -type f | wc -l)
[ "$ASSET_COUNT" -eq "$PIN_COUNT" ] || fail "assets/ has $ASSET_COUNT files, SUM pins $PIN_COUNT — unpinned/missing asset (pin is set equality over ALL files, any type/depth)"
printf '%s\n' "$SUM_LIST" | sha256sum -c --quiet || fail "generator asset missing or hash mismatch — update the SUM list above only via reviewed asset commits"
node scripts/pptx/build-awsops-intro-pptx.js "$WORK/rebuilt-deck.pptx" || fail "generator failed to rebuild the deck (not a provenance mismatch)"
diff <(sort <<<"$PARTS") <(unzip -Z1 "$WORK/rebuilt-deck.pptx" | sort) \
  || fail "pptx part list differs from generator output — extra or missing package parts"
unzip -q "$DECK" -d "$WORK/committed"
unzip -q "$WORK/rebuilt-deck.pptx" -d "$WORK/rebuilt"
# core.xml stays in the diff; strip only its volatile creation/modified stamps.
# NOTE: GNU `sed -i` — this script targets the ubuntu CI runners; run under gsed on macOS.
sed -i -E 's#(<dcterms:(created|modified)[^>]*>)[^<]*(</dcterms:(created|modified)>)#\1\3#g' \
  "$WORK/committed/docProps/core.xml" "$WORK/rebuilt/docProps/core.xml"
# the normalization must have actually removed the stamps — a pptxgenjs format
# change that dodges the pattern should fail loudly, not silently degrade
if grep -qE '<dcterms:(created|modified)[^>]*>[^<]' "$WORK/committed/docProps/core.xml" "$WORK/rebuilt/docProps/core.xml"; then
  fail "dcterms timestamp normalization did not apply — core.xml format changed"
fi
diff -r --no-dereference "$WORK/committed" "$WORK/rebuilt" \
  || fail "committed pptx does not match generator output — run 'node scripts/pptx/build-awsops-intro-pptx.js' and re-commit"
RELS_COUNT=$(find "$WORK/committed" -name '*.rels' | wc -l)
[ "$RELS_COUNT" -ge 1 ] || fail "no .rels parts found to scan — malformed pptx"
RC4=0
grep -rql 'TargetMode="External"' "$WORK/committed" --include='*.rels' && RC4=0 || RC4=$?
if [ "$RC4" -eq 0 ]; then fail "deck contains external relationship targets"; fi
if [ "$RC4" -ne 1 ]; then fail "external-target scan failed to run (grep exit $RC4)"; fi

echo "Deck verified: structure, content scan (3-pass), generator parity (full archive), no external targets — $DECK"
