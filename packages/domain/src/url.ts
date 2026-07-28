const trackingParameters = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
]);

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  const twitterHosts = new Set([
    'twitter.com',
    'www.twitter.com',
    'mobile.twitter.com',
    'x.com',
    'www.x.com',
  ]);
  const tweetMatch = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/i);
  if (twitterHosts.has(url.hostname) && tweetMatch) {
    const handle = tweetMatch[1];
    const tweetId = tweetMatch[2];
    if (handle !== undefined && tweetId !== undefined) {
      return `https://x.com/${handle.toLowerCase()}/status/${tweetId}`;
    }
  }

  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || trackingParameters.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
}
