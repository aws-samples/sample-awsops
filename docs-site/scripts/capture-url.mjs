const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function trustedOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))) {
    throw new Error('Capture login requires HTTPS or an explicit loopback HTTP origin');
  }
  return url.origin;
}

/** Hosted login domains, including Cognito, must be explicitly configured by the operator. */
export function captureUrlPolicy(baseUrl, hostedLoginUrl = '') {
  const appOrigin = trustedOrigin(baseUrl);
  const hostedOrigin = hostedLoginUrl ? trustedOrigin(hostedLoginUrl) : null;
  return {
    local: LOOPBACK_HOSTS.has(new URL(baseUrl).hostname),
    isApp(value) {
      const url = new URL(value);
      return !url.username && !url.password && url.origin === appOrigin;
    },
    isHostedLogin(value) {
      const url = new URL(value);
      return !url.username && !url.password && hostedOrigin !== null && url.origin === hostedOrigin;
    },
  };
}
