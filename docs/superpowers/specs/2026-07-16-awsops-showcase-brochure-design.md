# AWSops screenshot-led showcase brochure design

- **Date:** 2026-07-16
- **Branch:** `main`
- **Status:** Approved
- **Public route:** `/awsops/showcase/`
- **Primary CTA:** `https://awsops.atomai.click/`

## Summary

Add a second, standalone AWSops brochure under `docs-site` without replacing the
existing architecture-led `/awsops/brochure/` page. The new page is an
editorial product story built around current application screenshots. It targets
customer decision-makers and operations leaders, leads with the value of seeing
fragmented AWS operations in one place, then proves that value through the
dashboard, AI assistant, topology, cost, compliance, diagnosis, and the complete
v2 architecture.

The page remains a static, single-page brochure. It changes no v2 application,
backend, infrastructure, authentication, or product behavior.

## Goals

1. Let a first-time decision-maker understand AWSops in ten seconds.
2. Show the real product rather than relying on feature claims or decorative
   illustration.
3. Explain the complete v2 architecture after establishing product value.
4. Present the current product posture accurately: diagnosis and remediation
   proposals, with AWS resource mutation and autonomous remediation disabled.
5. End with one clear action: open the live product demo.
6. Work at mobile, tablet, and desktop widths and meet baseline accessibility
   expectations.

## Non-goals

- Replacing or editing `/awsops/brochure/`.
- Adding the showcase to the Docusaurus navbar or sidebar before comparison and
  adoption.
- Translating the showcase into English.
- Adding forms, analytics, backend APIs, or authentication exceptions.
- Enabling any frozen mutation, autonomy, or BYO-MCP capability.
- Changing the source screenshots used by the existing documentation.

## Audience and message hierarchy

The primary audience is a customer decision-maker or operations leader. The
secondary audience is a technical reviewer who wants evidence after the product
story.

Message hierarchy:

1. **Core message:** fragmented AWS operations become one coherent operating
   view.
2. **Proof:** operators can see the current state, ask questions against live
   data, explore relationships, and generate structured diagnosis reports.
3. **Trust:** the product is read-only by posture; it diagnoses and proposes,
   while infrastructure changes remain outside the product.
4. **Technical confidence:** the complete Terraform, ECS Fargate, Aurora,
   AgentCore, and asynchronous worker architecture is visible on the page.

The hero `h1` is the product name, **AWSops**. The value proposition
“흩어진 AWS 운영을 하나의 화면에” is supporting copy, not the product name.

## Information architecture

The page uses the approved “editorial product story” direction:

1. **Sticky navigation**
   - AWSops wordmark.
   - Anchors for Product, AI, Architecture, and Trust.
   - Primary “제품 데모 보기” CTA.
2. **Hero**
   - Full-width dashboard screenshot as the first-viewport product signal.
   - `AWSops` heading, core message, concise explanation, and demo CTA over the
     image in a readable non-card text region.
   - The hero height leaves the beginning of the next section visible on
     desktop and mobile.
3. **See**
   - Dashboard screenshot and short explanation of unified operational signals.
   - A restrained proof rail: 9 routing sections, 6 Well-Architected pillars,
     and 3 report export formats.
4. **Ask**
   - AI assistant answer screenshot.
   - Explain regex-first and classifier fallback routing only at the level a
     decision-maker needs: questions go to domain-specific read-only tools and
     return one synthesized answer.
5. **Explore**
   - Topology as the primary visual.
   - Cost Explorer and CIS compliance as two supporting visuals.
6. **Diagnose**
   - AI diagnosis report screenshot.
   - Explain asynchronous report generation, Well-Architected coverage, and
     MD/DOCX/PDF export.
7. **Architecture**
   - Complete, current v2 architecture diagram.
   - Short captions for edge/auth, thin BFF/data, AgentCore routing, and async
     workers.
8. **Trust**
   - Read-only posture, private edge, Cognito authentication, encrypted data,
     least-privilege tool access, and human-owned remediation decisions.
9. **Closing CTA**
   - Repeat the core message and link to `https://awsops.atomai.click/`.
10. **Footer**
    - Product name, current architecture stack, GitHub link, and link to the
      existing architecture-led brochure.

## Visual direction

The design retains option A's editorial sequence without using a cream or
single-hue theme.

- Base: white and light neutral surfaces.
- Text and high-contrast bands: graphite.
- Primary action and product emphasis: cobalt.
- Editorial emphasis: restrained coral.
- Semantic trust/status detail: teal and red only where meaningful.
- Cards, where genuinely needed, have an 8px maximum radius and are never
  nested.
- Sections are full-width bands or unframed layouts, not floating page cards.
- Typography uses local/system Korean-capable fonts; no font CDN is required.
- Letter spacing is `0`.
- No decorative orbs, bokeh, generic gradients, or illustrated hero artwork.
- Product screenshots remain legible and are never used as dark, blurred
  atmosphere.

## Screenshot assets and privacy

Create brochure-only derivatives under:

```text
docs-site/static/showcase/media/
  dashboard.webp
  assistant-answer.webp
  topology.webp
  cost-explorer.webp
  compliance.webp
  ai-diagnosis.webp
```

Source files:

```text
docs-site/static/screenshots/overview/dashboard.png
docs-site/static/screenshots/overview/assistant-answer.png
docs-site/static/screenshots/resources/topology-detail.png
docs-site/static/screenshots/cost/cost-explorer.png
docs-site/static/screenshots/operations/ai-diagnosis.png
```

`compliance.webp` is a second derivative of the current v2 dashboard screenshot,
cropped to the CIS compliance and security-summary band. The existing
`security/compliance.png` is a data-empty v1 screen and must not be used.
`topology-detail.png` is used instead of the full topology canvas so its five
resource labels can be replaced with generic role labels while preserving the
request-flow shape.

The original documentation screenshots remain untouched. Every brochure
derivative must mask or crop:

- AWS account IDs.
- Email addresses.
- Internal hostnames and private environment names.
- Resource identifiers that reveal customer or internal topology.
- Conversation-history text that is unrelated to the featured answer.

Masking must be baked into the derivative bitmap. CSS overlays are insufficient
because the underlying image would remain directly downloadable. Derivatives
use WebP at a practical visual quality and maximum display width so the page
does not ship six unbounded 1920x1080 PNGs. The hero image loads eagerly with
high fetch priority; below-fold screenshots use native lazy loading.

## Architecture diagram

Add adjacent diagram assets:

```text
docs-site/static/showcase/awsops-architecture.svg
docs-site/static/showcase/awsops-architecture.drawio
```

The diagram is refreshed against current v2 facts rather than blindly copying
stale brochure labels. It includes:

- CloudFront TLS and Lambda@Edge/Cognito authentication.
- CloudFront VPC Origin to the internal ALB on HTTPS.
- ECS Fargate arm64 thin BFF and Aurora Serverless v2.
- AgentCore Runtime, Memory, Code Interpreter, and 9 routed sections.
- The `observability` route to `external-obs`.
- AgentCore MCP Lambda tools as the live AWS query boundary.
- The asynchronous jobs path through SQS, dispatcher, Step Functions,
  Lambda/Fargate workers, status updater, and reaper.
- Read-only access to observed AWS resources and external observability
  datasources.

The desktop diagram is full width. At mobile widths, its wide SVG is rotated
into a tall viewport so labels remain readable, with a concise orientation hint
and a direct link to open the SVG at full size.

## Technical implementation

```text
docs-site/static/showcase/
  index.html
  awsops-architecture.svg
  awsops-architecture.drawio
  media/
```

`index.html` is a self-contained semantic HTML document with inline CSS and no
framework or build-time dependency. All local links are relative so Docusaurus'
project Pages base path remains valid. The only external navigation targets are
the live demo, GitHub repository, and existing brochure.

The page does not require JavaScript for core content. Any optional visual
enhancement must preserve the full page when scripting is unavailable and must
honor `prefers-reduced-motion`.

## Responsive behavior

- **Mobile, 375px:** one-column story; stable screenshot aspect ratios; no
  clipped text; architecture rotates to a readable vertical presentation.
- **Tablet, 768px:** two-column supporting visuals where content remains
  readable; the primary narrative remains sequential.
- **Desktop, 1440px:** full editorial composition with large screenshots and
  the complete architecture diagram.

Buttons, metrics, image frames, and architecture containers have stable
dimensions or aspect ratios so loading and hover states do not shift layout.

## Accessibility

- Korean `lang` attribute and descriptive page metadata.
- Skip link to the main content.
- Semantic landmarks and ordered heading levels.
- Visible `:focus-visible` treatment.
- WCAG AA text/background contrast.
- Descriptive alt text for meaningful screenshots and the architecture.
- Decorative details are hidden from assistive technology.
- `prefers-reduced-motion` disables nonessential motion.
- CTA labels describe their destination; external links do not rely on icons
  alone.

## Error and fallback behavior

- Local images and system fonts avoid CDN dependency.
- Missing images preserve their caption and alt text without collapsing the
  section.
- The page remains fully readable without CSS animation or JavaScript.
- The live-demo CTA is an ordinary link and does not block page rendering if
  the demo is unavailable.

## Verification

1. Run the brochure structural checker:

   ```bash
   python3 /home/atomoh/.codex/plugins/cache/oh-my-cloud-skills/aws-content-plugin/1.14.1/skills/brochure/scripts/check_brochure.py \
     docs-site/static/showcase/index.html
   ```

2. Build Docusaurus:

   ```bash
   cd docs-site && npm run build
   ```

3. Serve the build and verify `/awsops/showcase/` and every relative asset
   return HTTP 200.
4. Capture Playwright screenshots at 375px, 768px, and 1440px widths.
5. Inspect the screenshots for overlap, clipping, blank images, unreadable
   architecture labels, layout shifts, and next-section visibility below the
   hero.
6. Inspect every derived bitmap for account IDs, email addresses, internal
   hostnames, and sensitive resource identifiers.
7. Run the brochure content review and require a score of at least 85 before
   considering the page ready.
8. Confirm the live-demo CTA resolves to `https://awsops.atomai.click/`.

## Acceptance criteria

- `/awsops/showcase/` is emitted by the docs-site build without modifying the
  existing `/awsops/brochure/`.
- The six approved product views and the complete current v2 architecture are
  present.
- No sensitive identifier is visible in a showcase image.
- Copy does not claim autonomous remediation or AWS-resource mutation.
- Mobile, tablet, and desktop screenshots are free from overlap and clipping.
- Structural checker, Docusaurus build, asset HTTP checks, and content review
  all pass.
- The primary CTA opens the supplied v2 demo URL.
