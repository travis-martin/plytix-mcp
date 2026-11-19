const AUTH_HEADERS = ['authorization', 'x-mcp-token', 'x-plytix-api-key', 'x-plytix-api-password'];
const SAFE_FAILURE = 'Review panel authentication request failed.';

function authenticationHeaders(values) {
  const headers = new Headers(values);
  if ([...headers.keys()].some(name => !AUTH_HEADERS.includes(name)) || AUTH_HEADERS.some(name => !headers.get(name))) throw new Error(SAFE_FAILURE);
  return headers;
}

function sameHeaders(left, right) {
  return AUTH_HEADERS.every(name => left.get(name) === right.get(name));
}

export function createReviewPanelFetch({ url, initialHeaders, getHeaders, fetch: fetchRequest = globalThis.fetch }) {
  const service = new URL(url);
  if (service.protocol !== 'https:' || service.username || service.password) throw new Error(SAFE_FAILURE);
  let current = authenticationHeaders(initialHeaders), refreshing;

  async function refresh(previous) {
    if (current !== previous) return current;
    if (!refreshing) {
      refreshing = Promise.resolve().then(getHeaders).then(values => {
        const updated = authenticationHeaders(values);
        if (!sameHeaders(current, updated)) current = updated;
        return current;
      }).finally(() => { refreshing = undefined; });
    }
    return refreshing;
  }

  return async (input, init) => {
    try {
      const target = new URL(input instanceof Request ? input.url : input);
      if (target.origin !== service.origin || target.username || target.password) throw new Error();
      const request = new Request(input, { ...init, redirect: 'error' });
      const send = authentication => {
        const headers = new Headers(request.headers);
        for (const name of AUTH_HEADERS) headers.set(name, authentication.get(name));
        return fetchRequest(new Request(request.clone(), { headers, redirect: 'error' }));
      };
      const previous = current;
      const response = await send(previous);
      if (![401, 403].includes(response.status) || request.signal.aborted) return response;
      const updated = await refresh(previous);
      if (sameHeaders(previous, updated)) return response;
      // Authentication rejected this attempt. Retry its identical body once;
      // network failures and other statuses never replay a draft operation.
      void response.body?.cancel().catch(() => {});
      return await send(updated);
    } catch { throw new Error(SAFE_FAILURE); }
  };
}
