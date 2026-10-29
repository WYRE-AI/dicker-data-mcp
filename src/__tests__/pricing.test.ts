import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePricingTool, PRICING_TOOLS } from '../tools/pricing.js';
import { runWithCredentials, setGetPriceAuthorizationProvider } from '../client.js';
import {
  FAKE_AUTH,
  getPriceMissingAuthorization401,
  getPriceSuccess,
  getPriceUnauthorised,
} from './fixtures/getprice.js';
import { textOf } from './test-helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('pricing tool descriptions', () => {
  const descOf = (name: string) => PRICING_TOOLS.find((t) => t.name === name)?.description ?? '';

  it('dickerdata_get_pricing does not claim live pricing and mentions PricingRequest', () => {
    const desc = descOf('dickerdata_get_pricing');
    expect(desc).toContain('PricingRequest');
    expect(desc.replace(/may lag your live account price and stock/gi, '')).not.toMatch(/\blive\b/i);
  });

  it('dickerdata_get_price says it tries live GetPrice then falls back with live:false and a warning', () => {
    const desc = descOf('dickerdata_get_price');
    expect(desc).toContain('GetPrice');
    expect(desc).toContain('PricingRequest');
    expect(desc).toContain('live:false');
    expect(desc).toContain('warning');
    expect(desc).toMatch(/Tries Dicker's live GetPrice endpoint first/);
  });
});

describe('handlePricingTool', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    setGetPriceAuthorizationProvider(null);
    vi.unstubAllGlobals();
  });

  it('dickerdata_get_pricing exchanges an AccessKey then queries by product codes', async () => {
    const creds = { accountCode: 'ACC-TOOL-1', accessToken: 'tok-tool-1' };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-tool-1', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(
        jsonResponse({ SearchResult: [{ PartNumber: 'ABC123', UnitPrice: '10.00', SOH: '5' }] })
      );

    const result = await runWithCredentials(creds, () =>
      handlePricingTool('dickerdata_get_pricing', { productCodes: ['ABC123'] })
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('ABC123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const accessKeyCall = fetchMock.mock.calls[0];
    expect(accessKeyCall[0]).toBe('https://b2b-api.dickerdata.com.au/api/AccessKeyRequest');

    const pricingUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(pricingUrl.pathname).toBe('/api/PricingRequest');
    expect(pricingUrl.searchParams.getAll('pricingRequest.products')).toEqual(['ABC123']);
    expect(pricingUrl.searchParams.get('pricingRequest.accessKey')).toBe('ak-tool-1');
  });

  it('dickerdata_get_pricing rejects an empty productCodes array without calling the vendor', async () => {
    const creds = { accountCode: 'ACC-TOOL-2', accessToken: 'tok-tool-2' };

    const result = await runWithCredentials(creds, () =>
      handlePricingTool('dickerdata_get_pricing', { productCodes: [] })
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/non-empty array/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an error result when no credentials are configured', async () => {
    const result = await handlePricingTool('dickerdata_get_pricing', { productCodes: ['ABC123'] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No Dicker Data credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const accessKeyResponse = (ak: string) =>
    jsonResponse({ AccessKey: ak, ExpireDateTime: new Date(Date.now() + 600_000).toISOString() });
  const pricingFixture = { Status: 'SUCCESS', SearchResult: [{ PartNumber: 'XYZ999', UnitPrice: '99.00', SOH: '4' }] };
  const getPrice = (creds: { accountCode: string; accessToken: string }, args: Record<string, unknown> = {}) =>
    runWithCredentials(creds, () => handlePricingTool('dickerdata_get_price', { productCode: 'XYZ999', ...args }));
  /** Routes by URL and builds a fresh Response per call (bodies are single-use). */
  const route = (getPriceResponse: () => Response | Promise<Response>) =>
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('AccessKeyRequest')) return accessKeyResponse('ak-route');
      if (url.includes('/GetPrice')) return getPriceResponse();
      return jsonResponse(pricingFixture);
    });
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
  const parse = (r: Awaited<ReturnType<typeof getPrice>>) => JSON.parse(textOf(r));

  it('dickerdata_get_price with the default provider makes no GetPrice call and falls back with a warning', async () => {
    const creds = { accountCode: 'ACC-TOOL-3', accessToken: 'tok-tool-3' };
    fetchMock.mockResolvedValueOnce(accessKeyResponse('ak-tool-3')).mockResolvedValueOnce(jsonResponse(pricingFixture));

    const result = await getPrice(creds, { quantity: 3 });

    expect(result.isError).toBeUndefined();
    const body = parse(result);
    expect(body.live).toBe(false);
    expect(body.source).toBe('PricingRequest');
    expect(body.fallbackReason).toBe('authorization-not-configured');
    expect(body.warning).toMatch(/Live GetPrice was unavailable .*may lag your live account price and stock/);
    expect(body.SearchResult[0].PartNumber).toBe('XYZ999');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls().some((u) => u.includes('GetPrice'))).toBe(false);
    const [url, init] = fetchMock.mock.calls[1];
    const pricingUrl = new URL(url as string);
    expect(pricingUrl.pathname).toBe('/api/PricingRequest');
    expect(pricingUrl.searchParams.getAll('pricingRequest.products')).toEqual(['XYZ999']);
    expect([...pricingUrl.searchParams.keys()].some((key) => /quantity/i.test(key))).toBe(false);
    expect(init.method).toBe('GET');
    expect(PRICING_TOOLS.find((tool) => tool.name === 'dickerdata_get_price')?.inputSchema.properties)
      .not.toHaveProperty('quantity');
  });

  it('dickerdata_get_price with an injected provider POSTs GetPrice with Authorization and returns live data', async () => {
    const creds = { accountCode: 'ACC-LIVE', accessToken: 'tok-live' };
    const provider = vi.fn().mockResolvedValue(FAKE_AUTH);
    setGetPriceAuthorizationProvider(provider);
    fetchMock.mockResolvedValueOnce(accessKeyResponse('ak-live')).mockResolvedValueOnce(jsonResponse(getPriceSuccess));

    const result = await getPrice(creds, { quantity: 5 });

    expect(provider).toHaveBeenCalledWith(creds);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://b2b-api.dickerdata.com.au/api/DickerData/GetPrice');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(FAKE_AUTH);
    const sent = JSON.parse(init.body as string);
    expect(sent.Products).toEqual(['XYZ999']);
    expect(sent.RequestHeader).toMatchObject({ Token: 'tok-live', AccessKey: 'ak-live' });
    expect(typeof sent.RequestHeader.TransactionID).toBe('string');
    expect(Object.keys(sent).sort()).toEqual(['Products', 'RequestHeader']);

    const body = parse(result);
    expect(body).toMatchObject({ source: 'GetPrice', live: true, productCode: 'XYZ999' });
    expect(body.warning).toBeUndefined();
    expect(body.ResponseHeader.Status).toBe('SUCCESS');
    expect(body.Out[0]).toMatchObject({ PartNumber: 'XYZ999', UnitPrice: 299, SOH: 71 });
  });

  describe('live GetPrice failures fall back to PricingRequest', () => {
    const cases: Array<[string, () => Response | Promise<Response>, string]> = [
      ['UNAUTHORISED status', () => jsonResponse(getPriceUnauthorised), 'vendor-status'],
      ['HTTP 401 missing Authorization', () => jsonResponse(getPriceMissingAuthorization401, 401), 'request-failed'],
      ['HTTP 500', () => jsonResponse({}, 500), 'request-failed'],
      ['malformed body (no Out)', () => jsonResponse({ ResponseHeader: { Status: 'SUCCESS' } }), 'malformed-response'],
      ['non-success Status', () => jsonResponse({ ResponseHeader: { Status: 'FAILURE' }, Out: [] }), 'vendor-status'],
      ['non-JSON body', () => new Response('<html>', { status: 200 }), 'request-failed'],
    ];

    it.each(cases)('%s', async (_name, makeResponse, reason) => {
      const creds = { accountCode: 'ACC-FB', accessToken: 'tok-fb' };
      setGetPriceAuthorizationProvider(async () => FAKE_AUTH);
      route(makeResponse);

      const result = await getPrice(creds);

      expect(result.isError).toBeUndefined();
      const body = parse(result);
      expect(body.live).toBe(false);
      expect(body.fallbackReason).toBe(reason);
      expect(body.warning).toContain('may lag your live account price and stock');
      expect(textOf(result)).not.toContain(FAKE_AUTH);
      expect(new URL(urls().at(-1)!).pathname).toBe('/api/PricingRequest');
    });

    it('fetch rejection', async () => {
      const creds = { accountCode: 'ACC-FB2', accessToken: 'tok-fb2' };
      setGetPriceAuthorizationProvider(async () => FAKE_AUTH);
      route(() => {
        throw new Error(`socket hang up while sending ${FAKE_AUTH}`);
      });

      const result = await getPrice(creds);

      const body = parse(result);
      expect(body.live).toBe(false);
      expect(body.warning).toContain('socket hang up');
      expect(textOf(result)).not.toContain(FAKE_AUTH);
    });

    it('does not retry GetPrice on an UNAUTHORISED status', async () => {
      const creds = { accountCode: 'ACC-FB3', accessToken: 'tok-fb3' };
      setGetPriceAuthorizationProvider(async () => FAKE_AUTH);
      route(() =>
        jsonResponse({ ResponseHeader: { Status: 'UNAUTHORISED', ErrorDescription: 'invalid access key' }, Out: [] })
      );

      await getPrice(creds);

      expect(urls().filter((u) => u.includes('/GetPrice'))).toHaveLength(1);
      expect(urls().filter((u) => u.includes('AccessKeyRequest'))).toHaveLength(1);
    });
  });

  it('dickerdata_get_price errors mentioning both failures when the fallback also fails, without leaking Authorization', async () => {
    const creds = { accountCode: 'ACC-BOTH', accessToken: 'tok-both' };
    setGetPriceAuthorizationProvider(async () => FAKE_AUTH);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('AccessKeyRequest')) return accessKeyResponse('ak-both');
      if (url.includes('/GetPrice')) return jsonResponse(getPriceUnauthorised);
      return jsonResponse({}, 503);
    });

    const result = await getPrice(creds);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/GetPrice/);
    expect(text).toMatch(/UNAUTHORISED/);
    expect(text).toMatch(/PricingRequest fallback also failed/);
    expect(text).toMatch(/HTTP 503/);
    expect(text).not.toContain(FAKE_AUTH);
  });

  it('redacts the Authorization value if the vendor echoes it in a 401 body', async () => {
    const creds = { accountCode: 'ACC-ECHO', accessToken: 'tok-echo' };
    setGetPriceAuthorizationProvider(async () => FAKE_AUTH);
    route(() => jsonResponse({ ResponseHeader: { ErrorDescription: `bad ${FAKE_AUTH}` }, Out: [] }, 401));

    const result = await getPrice(creds);

    expect(parse(result).live).toBe(false);
    expect(textOf(result)).not.toContain(FAKE_AUTH);
    expect(parse(result).warning).toContain('[redacted]');
  });

  it('dickerdata_get_pricing never calls GetPrice, even with a provider configured', async () => {
    const creds = { accountCode: 'ACC-GP', accessToken: 'tok-gp' };
    setGetPriceAuthorizationProvider(async () => FAKE_AUTH);
    fetchMock.mockResolvedValueOnce(accessKeyResponse('ak-gp')).mockResolvedValueOnce(jsonResponse(pricingFixture));

    await runWithCredentials(creds, () => handlePricingTool('dickerdata_get_pricing', { productCodes: ['XYZ999'] }));

    expect(urls().some((u) => u.includes('GetPrice'))).toBe(false);
    expect(new URL(urls()[1]).pathname).toBe('/api/PricingRequest');
  });

  it('dickerdata_get_price requires productCode without calling fetch', async () => {
    const result = await runWithCredentials({ accountCode: 'ACC-MISSING', accessToken: 'tok-missing' }, () =>
      handlePricingTool('dickerdata_get_price', {})
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('productCode is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
