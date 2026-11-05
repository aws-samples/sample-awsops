# AWSops product-tour (HyperFrames)

Source for the docs-site landing hero video: `docs-site/static/video/product-tour.{mp4,webm}` + `product-tour-poster.webp`.

30s, 1280x720, no audio. Ten beats: title → dashboard → AI assistant → topology → cost explorer → security → compliance (ultra-wide banner, `.shot-frame-banner`, shown uncropped) → EKS → AI diagnosis → outro (holds on the final frame). Screenshots are copied from `docs-site/static/showcase/media/*.webp` (already privacy-redacted and SHA256-pinned there — this project only reads them, never edits them). Ken Burns is deliberately subtle (±2%, see `scene()` in index.html) — several captures have UI flush against the crop edge (card borders, a heading with no left margin), and a bigger zoom crops symmetrically from center into whichever side has no margin.

## Why this exists as committed binaries

The GitHub Pages build (`.github/workflows/deploy-guide.yml`) runs on Node 20 with no ffmpeg, and the HyperFrames CLI requires Node ≥22 + ffmpeg. CI cannot render this. The mp4/webp are committed static assets; re-render locally when the product UI changes enough to make the tour stale (roughly: a redesign of dashboard/assistant/topology/diagnosis, or a refresh of the underlying `static/showcase/media/*.webp` set).

## Toolchain (one-time, no sudo)

```bash
# Node >=22 (this repo's default runner has Node 20)
curl -fL -o /tmp/node22.tar.xz https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-arm64.tar.xz
tar xf /tmp/node22.tar.xz -C /tmp
mv /tmp/node-v22.18.0-linux-arm64 ~/.local/node22
export PATH="$HOME/.local/node22/bin:$PATH"

# ffmpeg/ffprobe static build (Playwright's bundled ffmpeg is VP8-only, no libx264/mp4)
curl -fL -o /tmp/ffmpeg-static.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz
tar xf /tmp/ffmpeg-static.tar.xz -C /tmp
cp /tmp/ffmpeg-*-arm64-static/{ffmpeg,ffprobe} ~/.local/bin/

# Chromium: reuse Playwright's cached build (HyperFrames' own installer has no arm64 headless shell)
export HYPERFRAMES_BROWSER_PATH="$HOME/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell"
# ^ adjust the version suffix to whatever `ls ~/.cache/ms-playwright` shows

npx hyperframes@latest doctor --json | jq -e '.ok'
```

## Regenerate

```bash
cd docs-site/hyperframes/product-tour
npx hyperframes@latest lint
npx hyperframes@latest check
npx hyperframes@latest snapshot . --at 0,0.7,1.2,3,4.65,8.1,11.55,15,18.45,21.9,25.35,28.8,29.9,30.0 -o /tmp/hf-snapshots --no-end
# eyeball /tmp/hf-snapshots/contact-sheet-*.jpg, then:
npx hyperframes@latest render --quality high --output ../../static/video/product-tour.mp4

# the raw render is ~3.5MB; recompress to keep the landing page light (~600KB, budget ≤2MB)
cd ../../static/video
ffmpeg -y -i product-tour.mp4 -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart -an product-tour.compressed.mp4
mv product-tour.compressed.mp4 product-tour.mp4

# WebM/VP9 fallback — plain Chromium (no proprietary codec license: Playwright's bundled
# browser, some Linux distro Firefox/Chromium builds) can't decode H.264 at all
# (`canPlayType('video/mp4;codecs="avc1.42E01E"')` returns ""); VP9 fills that gap. Listed
# as the FIRST <source> in index.tsx so a browser that can decode it prefers it; real Chrome/
# Firefox/Safari with H.264 licensing fall through to the mp4 <source> right after.
ffmpeg -y -i product-tour.mp4 -c:v libvpx-vp9 -crf 34 -b:v 0 -pix_fmt yuv420p -an product-tour.webm

ffmpeg -y -ss 2.0 -i product-tour.mp4 -frames:v 1 -update 1 poster.png
ffmpeg -y -i poster.png -quality 85 product-tour-poster.webp
rm poster.png
ffprobe -v error -show_format product-tour.mp4   # confirm duration=30.0, size
```

## Notes

- The `t=30.0` (exact `data-duration`) snapshot renders black — that's the snapshot tool sampling past the last real frame, not a defect. `t=29.9` (and the actual rendered video, fps-quantized before the boundary) holds the outro correctly. Verify with `ffmpeg -ss 29.9 -i product-tour.mp4 -frames:v 1 ...` after any re-render.
- `.shot-frame` containers carry `data-layout-allow-overflow="true"` — the Ken Burns zoom intentionally overflows the rounded frame by design; this silences the (informational) layout audit for that specific choice.
- Font is `Noto Sans CJK KR` via `src: local(...)` — it's installed system-wide on this box (`fc-list | grep -i "noto sans cjk"`). No network font fetch, so renders stay deterministic.
- Ship both `product-tour.webm` (VP9, first `<source>`) and `product-tour.mp4` (H.264, second `<source>`) — don't drop either. Verifying autoplay end-to-end in this environment requires the VP9 file (see codec check above); real users mostly hit the mp4.
