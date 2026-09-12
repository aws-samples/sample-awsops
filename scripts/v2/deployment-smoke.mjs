// Keep service Host/SNI and TLS verification while connecting through CloudFront.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function smokeArgs(publicUrl, cloudfrontDomain) {
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash
      || !/^[a-z0-9.-]+$/i.test(url.hostname)
      || !/^d[a-z0-9]+\.cloudfront\.net$/.test(cloudfrontDomain)) {
    throw new Error('Smoke requires an HTTPS service URL and a CloudFront distribution domain');
  }
  return ['-fsS', '--max-time', '30', '--connect-to',
    `${url.hostname}:443:${cloudfrontDomain}:443`, `${url.origin}/api/health`];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) {
      throw new Error('Usage: node deployment-smoke.mjs <public-url> <cloudfront-domain>');
    }
    execFileSync('curl', smokeArgs(process.argv[2], process.argv[3]), { stdio: 'inherit' });
  } catch (error) {
    console.error(`Deployment smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
