// Keep service Host/SNI and TLS verification while connecting through CloudFront.
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
