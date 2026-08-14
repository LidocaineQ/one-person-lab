const SENSITIVE_QUERY_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'awsaccesskeyid',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentials',
  'googleaccessid',
  'idtoken',
  'key',
  'oauthtoken',
  'password',
  'passwd',
  'privatetoken',
  'pwd',
  'refreshtoken',
  'secret',
  'securitytoken',
  'sessiontoken',
  'sig',
  'signature',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
  'xgoogcredential',
  'xgoogsignature',
]);

function normalizedQueryKey(value: string) {
  let decoded = value.replace(/\+/g, ' ');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // URLSearchParams also tolerates malformed escapes; retain the undecoded key.
  }
  return decoded.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveQueryKey(value: string) {
  const normalized = normalizedQueryKey(value);
  return SENSITIVE_QUERY_KEYS.has(normalized)
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('authtoken')
    || normalized.endsWith('privatetoken')
    || normalized.endsWith('securitytoken');
}

function mayRetainSshUsername(url: URL) {
  return (url.protocol === 'ssh:' || url.protocol === 'git+ssh:')
    && Boolean(url.username)
    && !url.password;
}

function sanitizeParsedUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  let changed = false;
  if ((url.username || url.password) && !mayRetainSshUsername(url)) {
    url.username = '';
    url.password = '';
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveQueryKey(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? url.toString() : value;
}

function sanitizeUnparsedUrl(value: string) {
  let displayUrl = value;
  const authority = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(displayUrl);
  if (authority) {
    const scheme = authority[1].toLowerCase();
    const userInfoEnd = authority[2].lastIndexOf('@');
    const userInfo = userInfoEnd >= 0 ? authority[2].slice(0, userInfoEnd) : '';
    const mayRetainUsername = (scheme === 'ssh' || scheme === 'git+ssh')
      && userInfoEnd >= 0
      && !userInfo.includes(':');
    if (userInfoEnd >= 0 && !mayRetainUsername) {
      const authorityStart = authority[0].length - authority[2].length;
      displayUrl = `${displayUrl.slice(0, authorityStart)}${authority[2].slice(userInfoEnd + 1)}`
        + displayUrl.slice(authority[0].length);
    }
  }

  const queryStart = displayUrl.indexOf('?');
  if (queryStart < 0) {
    return displayUrl;
  }
  const fragmentStart = displayUrl.indexOf('#', queryStart);
  const queryEnd = fragmentStart >= 0 ? fragmentStart : displayUrl.length;
  const query = displayUrl.slice(queryStart + 1, queryEnd);
  const params = new URLSearchParams(query);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (isSensitiveQueryKey(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) {
    return displayUrl;
  }
  const sanitizedQuery = params.toString();
  const fragment = fragmentStart >= 0 ? displayUrl.slice(fragmentStart) : '';
  return `${displayUrl.slice(0, queryStart)}${sanitizedQuery ? `?${sanitizedQuery}` : ''}${fragment}`;
}

export function workspaceTransportDisplayUrl(value: string) {
  return sanitizeParsedUrl(value) ?? sanitizeUnparsedUrl(value);
}
