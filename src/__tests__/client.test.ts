import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPricing, requestAccessKey } from '../client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('requestAccessKey', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts TransactionID/AccessToken/AccountCode and returns the AccessKey + parsed expiry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        AccessKey: 'ak-123',
        ExpireDateTime: new Date(Date.now() + 60_000).toISOString(),
        Status: 'Success',
      })
    );

    const result = await requestAccessKey({ accountCode: 'ACC1', accessToken: 'tok1' });

    expect(result.accessKey).toBe('ak-123');
    expect(result.expireAt).toBeGreaterThan(Date.now());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://b2b-api.dickerdata.com.au/api/AccessKeyRequest');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.AccountCode).toBe('ACC1');
    expect(body.AccessToken).toBe('tok1');
    expect(typeof body.TransactionID).toBe('string');
  });

  it('throws when the vendor returns 2xx with no AccessKey', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Status: 'Failed', Message: 'Invalid credentials' }));

    await expect(requestAccessKey({ accountCode: 'bad', accessToken: 'bad' })).rejects.toThrow(
      /Invalid credentials/
    );
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

    await expect(requestAccessKey({ accountCode: 'ACC1', accessToken: 'tok1' })).rejects.toThrow(/HTTP 500/);
  });
});

describe('getPricing - accessKey caching and refresh', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges an AccessKey once and embeds it in the pricing request query string', async () => {
    const creds = { accountCode: 'ACC-CACHE', accessToken: 'tok-cache' };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-cache-1', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(jsonResponse({ SearchResult: [{ PartNumber: 'ABC123', UnitPrice: '10.00' }] }));

    const result = await getPricing(creds, ['ABC123']);

    expect(result.SearchResult?.[0].PartNumber).toBe('ABC123');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const pricingUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(pricingUrl.pathname).toBe('/api/PricingRequest');
    expect(pricingUrl.searchParams.get('pricingRequest.accessKey')).toBe('ak-cache-1');
    expect(pricingUrl.searchParams.get('pricingRequest.token')).toBe('tok-cache');
    expect(pricingUrl.searchParams.getAll('pricingRequest.products')).toEqual(['ABC123']);

    // A second call with the same credentials must reuse the cached
    // AccessKey rather than re-exchanging it.
    fetchMock.mockResolvedValueOnce(jsonResponse({ SearchResult: [] }));
    await getPricing(creds, ['XYZ999']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never shares a cached AccessKey between two tenants whose credentials would collide under a naive colon-join', async () => {
    // accountCode="A:B"/accessToken="C" and accountCode="A"/accessToken="B:C"
    // both concatenate to "A:B:C" under a plain `${a}:${b}` join — this
    // guards the actual cache-key encoding against that collision.
    const tenantOne = { accountCode: 'A:B', accessToken: 'C' };
    const tenantTwo = { accountCode: 'A', accessToken: 'B:C' };

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-tenant-one', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(jsonResponse({ SearchResult: [] }));
    await getPricing(tenantOne, ['ABC123']);

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-tenant-two', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(jsonResponse({ SearchResult: [] }));
    await getPricing(tenantTwo, ['ABC123']);

    // 4 total fetches (exchange+request per tenant) means tenant two did its
    // own AccessKeyRequest exchange rather than reusing tenant one's cached
    // key — a colon-join collision would collapse this to 3.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const tenantTwoPricingUrl = new URL(fetchMock.mock.calls[3][0] as string);
    expect(tenantTwoPricingUrl.searchParams.get('pricingRequest.accessKey')).toBe('ak-tenant-two');
  });

  it('refreshes the AccessKey exactly once when the vendor rejects it mid-call, then retries', async () => {
    const creds = { accountCode: 'ACC-REFRESH', accessToken: 'tok-refresh' };
    fetchMock
      // Initial exchange
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-stale', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      // First pricing call: vendor says the key is invalid (HTTP 401)
      .mockResolvedValueOnce(jsonResponse({}, 401))
      // Forced re-exchange
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-fresh', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      // Retried pricing call succeeds
      .mockResolvedValueOnce(jsonResponse({ SearchResult: [{ PartNumber: 'ABC123' }] }));

    const result = await getPricing(creds, ['ABC123']);

    expect(result.SearchResult?.[0].PartNumber).toBe('ABC123');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const retriedUrl = new URL(fetchMock.mock.calls[3][0] as string);
    expect(retriedUrl.searchParams.get('pricingRequest.accessKey')).toBe('ak-fresh');
  });
});
