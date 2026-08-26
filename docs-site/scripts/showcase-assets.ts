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
    sourceSha256: '46d9804a7220e073ab90dcce0567a0a9dbf9ba22f8ed934f88c2c3e799f70d10',
    output: 'dashboard.webp',
    crop: {left: 0, top: 0, width: 1920, height: 1080},
    outputWidth: 1600,
    overlays: [
      {
        left: 42, top: 958, width: 180, height: 58,
        fill: '#f4f6f8', text: '#526173', label: 'Demo operator',
        sample: {left: 58, top: 971},
      },
      {
        left: 846, top: 210, width: 448, height: 112,
        fill: '#fff', text: '#526173', label: 'Recent AI operations',
        sample: {left: 1108, top: 225},
      },
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'assistant-answer.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '0e0024c0fef4880884fecda732af69a4e1cc44a2458d62fd6b200272551218c5',
    output: 'assistant-answer.webp',
    crop: {left: 590, top: 112, width: 720, height: 890},
    outputWidth: 1200,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'resources', 'topology-detail.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '69dbf8060f0f10dcc34e7bd718e2e27bbb689d73af09545334c490d5199de2dd',
    output: 'topology.webp',
    crop: {left: 288, top: 160, width: 1150, height: 860},
    outputWidth: 1400,
    overlays: [
      {
        left: 700, top: 108, width: 232, height: 38,
        fill: '#e8f8ee', text: '#17362b', label: 'DNS endpoint',
        sample: {left: 813, top: 124},
      },
      {
        left: 700, top: 270, width: 232, height: 38,
        fill: '#eaf1ff', text: '#1f3763', label: 'CloudFront',
        sample: {left: 801, top: 285},
      },
      {
        left: 700, top: 429, width: 232, height: 38,
        fill: '#fff0dc', text: '#523819', label: 'Load balancer',
        sample: {left: 863, top: 444},
      },
      {
        left: 700, top: 591, width: 232, height: 38,
        fill: '#f2e9ff', text: '#3e2a5c', label: 'Target group',
        sample: {left: 912, top: 607},
      },
      {
        left: 700, top: 752, width: 232, height: 38,
        fill: '#e5f8f5', text: '#173d38', label: 'Healthy targets',
        sample: {left: 897, top: 765},
      },
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'cost', 'cost-explorer.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '3b2d9ab68bc405fc0bb9e8df295c4ccccbd45d895e60ff682248494ad3ee139b',
    output: 'cost-explorer.webp',
    crop: {left: 288, top: 104, width: 1600, height: 900},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: '46d9804a7220e073ab90dcce0567a0a9dbf9ba22f8ed934f88c2c3e799f70d10',
    output: 'compliance.webp',
    crop: {left: 288, top: 386, width: 1600, height: 190},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'operations', 'ai-diagnosis.png'),
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceSha256: 'aa2aea36c7a008d2171aebcb06bb50e0450bb71abb09ece6560ef58e60664705',
    output: 'ai-diagnosis.webp',
    crop: {left: 568, top: 128, width: 1320, height: 900},
    outputWidth: 1600,
    overlays: [
      {
        left: 190, top: 214, width: 275, height: 42,
        fill: '#f4f6f8', text: '#18212d', label: '호스트 계정 (mid)',
        sample: {left: 378, top: 235},
      },
    ],
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

export function validateAssetSpecs(
  sourceWidth: number,
  sourceHeight: number,
  assets: AssetSpec[] = ASSETS,
): void {
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
    if (asset.sourceWidth !== sourceWidth || asset.sourceHeight !== sourceHeight) {
      throw new Error(
        `unexpected source dimensions for ${asset.output}: expected ${sourceWidth}x${sourceHeight}`,
      );
    }

    const {crop} = asset;
    if (
      crop.left < 0 ||
      crop.top < 0 ||
      crop.left + crop.width > sourceWidth ||
      crop.top + crop.height > sourceHeight
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
