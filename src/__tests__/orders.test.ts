import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOrderTool, ORDER_TOOLS, CREATE_ORDER_UNAVAILABLE_MESSAGE } from '../tools/orders.js';
import { runWithCredentials } from '../client.js';
import { textOf } from './test-helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('handleOrderTool', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dickerdata_create_order is unavailable without any vendor calls', async () => {
    const result = await runWithCredentials({ accountCode: 'ACC-ORD-1', accessToken: 'tok-ord-1' }, () =>
      handleOrderTool('dickerdata_create_order', { items: [{ partNumber: 'ABC123', quantity: 2 }] })
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(CREATE_ORDER_UNAVAILABLE_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ORDER_TOOLS[0].description).toMatch(/^TEMPORARILY UNAVAILABLE/);
  });

  it('returns the unavailable message even without credentials', async () => {
    const result = await handleOrderTool('dickerdata_create_order', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(CREATE_ORDER_UNAVAILABLE_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dickerdata_create_order rejects an empty items array without calling the vendor', async () => {
    const creds = { accountCode: 'ACC-ORD-2', accessToken: 'tok-ord-2' };
    const result = await runWithCredentials(creds, () => handleOrderTool('dickerdata_create_order', { items: [] }));
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-exchanges the AccessKey and retries once when the vendor rejects it on GetOrderDetails', async () => {
    const creds = { accountCode: 'ACC-ORD-3', accessToken: 'tok-ord-3' };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-stale', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-fresh', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(jsonResponse({ OrderNumber: 'SO99999' }));

    const result = await runWithCredentials(creds, () =>
      handleOrderTool('dickerdata_get_order_details', { orderNumber: 'SO99999' })
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('SO99999');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const finalUrl = new URL(fetchMock.mock.calls[3][0] as string);
    expect(finalUrl.searchParams.get('request.requestHeader.accessKey')).toBe('ak-fresh');
    expect(finalUrl.searchParams.get('request.in.orderNumber')).toBe('SO99999');
  });

  it('dickerdata_get_consignment_status requires a consignmentNumber', async () => {
    const creds = { accountCode: 'ACC-ORD-4', accessToken: 'tok-ord-4' };
    const result = await runWithCredentials(creds, () =>
      handleOrderTool('dickerdata_get_consignment_status', {})
    );
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
