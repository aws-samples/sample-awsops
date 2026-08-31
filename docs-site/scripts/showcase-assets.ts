import {createHash} from 'node:crypto';
import path from 'node:path';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Overlay extends Rect {
  fill: string;
  text: string;
  label?: string;
  sample: {
    left: number;
    top: number;
  };
}

export interface AssetSpec {
  source: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceSha256: string;
  output: string;
  crop: Rect;
  outputWidth: number;
  overlays: Overlay[];
}

const SCREENSHOTS = path.join('static', 'screenshots');

export const ASSETS: AssetSpec[] = [
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '2fbc6fbd1c37a3ca0bc7bb8586be48e0737dc7637d0a9aab2cd345a2b5bf030e',
    output: 'dashboard.webp',
    crop: {left: 0, top: 0, width: 1920, height: 1080},
    outputWidth: 1600,
    overlays: [
      {
        left: 8, top: 976, width: 230, height: 48,
        fill: '#f4f6f8', text: '#526173', label: 'Demo operator',
        sample: {left: 17, top: 1015},
      },
      {
        left: 828, top: 167, width: 534, height: 201,
        fill: '#fff', text: '#526173', label: 'Recent AI conversation',
        sample: {left: 920, top: 201},
      },
      {
        left: 1378, top: 167, width: 504, height: 201,
        fill: '#fff', text: '#526173', label: 'AI analysis',
        sample: {left: 1436, top: 201},
      },
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'assistant-answer.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '8ec351e94e76e42ee8ea5515fa49a15509864a7648a1faf6fe8e74eb9b30bc0c',
    output: 'assistant-answer.webp',
    crop: {left: 606, top: 114, width: 904, height: 894},
    outputWidth: 1200,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'resources', 'topology-detail.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: 'f57282d1fdc738072988830baa8ccaec2ed4641c6030ad5ce5c805c4c54688e1',
    output: 'topology.webp',
    crop: {left: 400, top: 250, width: 1055, height: 720},
    outputWidth: 1400,
    overlays: [
      {
        left: 330, top: 26, width: 278, height: 44,
        fill: '#e8f8ee', text: '#17362b', label: 'DNS endpoint',
        sample: {left: 468, top: 30},
      },
      {
        left: 185, top: 186, width: 276, height: 46,
        fill: '#eaf1ff', text: '#1f3763', label: 'CloudFront',
        sample: {left: 321, top: 192},
      },
      {
        left: 620, top: 349, width: 282, height: 44,
        fill: '#fff0dc', text: '#523819', label: 'Load balancer',
        sample: {left: 700, top: 368},
      },
      {
        left: 480, top: 510, width: 270, height: 42,
        fill: '#f2e9ff', text: '#3e2a5c', label: 'Target group',
        sample: {left: 613, top: 511},
      },
      {
        left: 773, top: 510, width: 270, height: 42,
        fill: '#f2e9ff', text: '#3e2a5c', label: 'Target group',
        sample: {left: 906, top: 511},
      },
      {
        left: 480, top: 670, width: 270, height: 42,
        fill: '#e5f8f5', text: '#173d38', label: 'Healthy targets',
        sample: {left: 490, top: 673},
      },
      {
        left: 773, top: 670, width: 270, height: 42,
        fill: '#e5f8f5', text: '#173d38', label: 'Healthy targets',
        sample: {left: 1031, top: 673},
      },
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'cost', 'cost-explorer.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '61168cb98800b80dc2a9d0b2124f7b2ac0bd3801cebd880ae11d548402032f13',
    output: 'cost-explorer.webp',
    crop: {left: 288, top: 104, width: 1600, height: 900},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '2fbc6fbd1c37a3ca0bc7bb8586be48e0737dc7637d0a9aab2cd345a2b5bf030e',
    output: 'compliance.webp',
    crop: {left: 288, top: 408, width: 1600, height: 190},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'operations', 'ai-diagnosis.png'),
    sourceWidth: 1920,
    // Recaptured 2026-08-28 (PR #247) at 1920x1040 — 40px shorter than the other sources, hence
    // per-asset dimensions in validateAssetSpecs. Crop bottom 128+900=1028 stays inside 1040.
    // NOTE: capture-screenshots.ts uses a fixed 1920x1080 viewport, so this capture came from a
    // different window state — the next scripted re-capture will emit 1080-high and must re-pin
    // BOTH this hash and this height (and re-verify the overlays) like any other recapture.
    sourceHeight: 1040,
    sourceSha256: '0d683739e0c1c3feec568965d75af2e5678e6e8909a1642b5822016e2cd9db6c',
    output: 'ai-diagnosis.webp',
    // left shifted 40px earlier (was 568) so the video's Ken Burns zoom-in has a margin to eat
    // into before it reaches the "AWS 진단 리포트" heading, which otherwise sits flush against
    // the old crop's left edge — right edge (568+1320=1888) kept identical.
    crop: {left: 528, top: 128, width: 1360, height: 900},
    outputWidth: 1600,
    overlays: [
      // The recaptured report (cost diagnosis) shows no account identifier anywhere inside the
      // crop (verified pixel-by-pixel against the new source) — the old '호스트 계정 (mid)'
      // mask covered an account ID the previous capture's report header displayed; it has no
      // pixels to cover now and re-adding it would blank real report text.
      {
        // Hides the sliver of the page's secondary settings panel (mailing-list "제거" button
        // fragment) exposed by the wider crop. Sample sits on the dark button text at
        // crop-rel (42,120) — the old (10,10) point is plain page background in the new
        // capture, which the generator test rejects as "source sample unexpectedly matches fill".
        left: 0, top: 0, width: 44, height: 900,
        fill: '#f7f8fa', text: '#f7f8fa',
        sample: {left: 42, top: 120},
      },
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'security', 'security.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '17d6518904efec2aaee4685070ec994f045c8c842bdc40b1ab60ee2dd703f554',
    output: 'security.webp',
    crop: {left: 288, top: 0, width: 1600, height: 900},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'resources', 'eks.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: 'fbf69350f2d7adaba49c19e7cb5691ac38ba29367a20e428b07383243ebfda7e',
    output: 'eks.webp',
    crop: {left: 288, top: 0, width: 1600, height: 900},
    outputWidth: 1600,
    overlays: [],
  },
];

function assertPositiveFiniteInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite integer`);
  }
}

export function assertSourceMatchesSpec(asset: AssetSpec, source: Buffer): void {
  const actualSha256 = createHash('sha256').update(source).digest('hex');
  if (actualSha256 !== asset.sourceSha256) {
    throw new Error(
      `source hash mismatch for ${asset.output}: expected ${asset.sourceSha256}, got ${actualSha256}`,
    );
  }

  const pngSignature = '89504e470d0a1a0a';
  if (
    source.length < 24 ||
    source.subarray(0, 8).toString('hex') !== pngSignature ||
    source.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new Error(`source dimensions mismatch for ${asset.output}: source is not a valid PNG`);
  }

  const actualWidth = source.readUInt32BE(16);
  const actualHeight = source.readUInt32BE(20);
  if (actualWidth !== asset.sourceWidth || actualHeight !== asset.sourceHeight) {
    throw new Error(
      `source dimensions mismatch for ${asset.output}: expected ${asset.sourceWidth}x${asset.sourceHeight}, got ${actualWidth}x${actualHeight}`,
    );
  }
}

// Validates each spec against ITS OWN declared source dimensions (per-asset since PR #247's
// 1920x1040 ai-diagnosis recapture — the fleet is no longer uniformly 1080p). Whether the
// declared dimensions match the actual on-disk PNG is enforced separately, fail-closed, by
// assertSourceMatchesSpec (hash + IHDR dims).
export function validateAssetSpecs(assets: AssetSpec[] = ASSETS): void {
  const outputs = new Set<string>();
  for (const asset of assets) {
    if (outputs.has(asset.output)) {
      throw new Error(`duplicate output: ${asset.output}`);
    }
    outputs.add(asset.output);

    if (path.basename(asset.output) !== asset.output || !/^[^/\\]+\.webp$/.test(asset.output)) {
      throw new Error(`invalid WebP output basename: ${asset.output}`);
    }
    assertPositiveFiniteInteger(asset.outputWidth, 'outputWidth');
    assertPositiveFiniteInteger(asset.crop.width, 'crop width');
    assertPositiveFiniteInteger(asset.crop.height, 'crop height');
    assertPositiveFiniteInteger(asset.sourceWidth, 'sourceWidth');
    assertPositiveFiniteInteger(asset.sourceHeight, 'sourceHeight');
    if (!/^[a-f0-9]{64}$/.test(asset.sourceSha256)) {
      throw new Error(`invalid source SHA-256: ${asset.output}`);
    }
    const {crop} = asset;
    if (
      crop.left < 0 ||
      crop.top < 0 ||
      crop.left + crop.width > asset.sourceWidth ||
      crop.top + crop.height > asset.sourceHeight
    ) {
      throw new Error(`crop outside source: ${asset.output}`);
    }

    for (const overlay of asset.overlays) {
      if (
        overlay.left < 0 ||
        overlay.top < 0 ||
        overlay.left + overlay.width > crop.width ||
        overlay.top + overlay.height > crop.height
      ) {
        throw new Error(`overlay outside crop: ${asset.output}`);
      }
      if (
        !Number.isInteger(overlay.sample?.left) ||
        !Number.isInteger(overlay.sample?.top) ||
        overlay.sample.left < overlay.left ||
        overlay.sample.top < overlay.top ||
        overlay.sample.left >= overlay.left + overlay.width ||
        overlay.sample.top >= overlay.top + overlay.height
      ) {
        throw new Error(`overlay sample outside overlay: ${asset.output}`);
      }
    }
  }
}
