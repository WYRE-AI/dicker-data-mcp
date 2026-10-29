import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePricingTool, PRICING_TOOLS } from '../tools/pricing.js';
import { runWithCredentials } from '../client.js';
import { textOf } from './test-helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('handlePricingTool', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
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

  it('dickerdata_get_price queries PricingRequest for exactly one product and ignores quantity', async () => {
    const creds = { accountCode: 'ACC-TOOL-3', accessToken: 'tok-tool-3' };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-tool-3', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(jsonResponse({ Status: 'SUCCESS', SearchResult: [{ PartNumber: 'XYZ999', UnitPrice: '99.00' }] }));

    const result = await runWithCredentials(creds, () =>
      handlePricingTool('dickerdata_get_price', { productCode: 'XYZ999', quantity: 3 })
    );

    expect(result.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[1];
    const pricingUrl = new URL(url as string);
    expect(pricingUrl.pathname).toBe('/api/PricingRequest');
    expect(pricingUrl.searchParams.getAll('pricingRequest.products')).toEqual(['XYZ999']);
    expect(pricingUrl.searchParams.get('pricingRequest.accessKey')).toBe('ak-tool-3');
    expect(pricingUrl.searchParams.get('pricingRequest.token')).toBe('tok-tool-3');
    expect([...pricingUrl.searchParams.keys()].some((key) => /quantity/i.test(key))).toBe(false);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(PRICING_TOOLS.find((tool) => tool.name === 'dickerdata_get_price')?.inputSchema.properties)
      .not.toHaveProperty('quantity');
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
