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

  for (const key of [...url.searchParams.keys()]) {
    if (key.toLocaleLowerCase().startsWith('utm_') || trackingParameters.has(key.toLocaleLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
}
