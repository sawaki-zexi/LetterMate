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
  url.hostname = url.hostname.toLocaleLowerCase();

  const twitterHosts = new Set([
    'twitter.com',
    'www.twitter.com',
    'mobile.twitter.com',
    'x.com',
    'www.x.com',
  ]);
  const tweetMatch = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/i);
  if (twitterHosts.has(url.hostname) && tweetMatch) {
    const [, handle, tweetId] = tweetMatch;
    return `https://x.com/${handle}/status/${tweetId}`;
  }

  for (const key of [...url.searchParams.keys()]) {
    if (key.toLocaleLowerCase().startsWith('utm_') || trackingParameters.has(key.toLocaleLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
}
