import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAccountTool } from '../tools/account.js';
import { runWithCredentials } from '../client.js';
import { textOf } from './test-helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('handleAccountTool', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dickerdata_list_invoices queries the date range with the exchanged AccessKey', async () => {
    const creds = { accountCode: 'ACC-INV-1', accessToken: 'tok-inv-1' };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-inv-1', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(jsonResponse({ Invoices: [{ InvoiceNumber: 'INV1' }] }));

    const result = await runWithCredentials(creds, () =>
      handleAccountTool('dickerdata_list_invoices', { startDate: '2026-01-01', endDate: '2026-01-31' })
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('INV1');

    const invoiceUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(invoiceUrl.pathname).toBe('/api/Account/Invoice');
    expect(invoiceUrl.searchParams.get('request.startDate')).toBe('2026-01-01');
    expect(invoiceUrl.searchParams.get('request.endDate')).toBe('2026-01-31');
    expect(invoiceUrl.searchParams.get('request.requestHeader.accessKey')).toBe('ak-inv-1');
  });

  it('dickerdata_get_invoice_details requires a salesOrderNumber', async () => {
    const creds = { accountCode: 'ACC-INV-2', accessToken: 'tok-inv-2' };
    const result = await runWithCredentials(creds, () => handleAccountTool('dickerdata_get_invoice_details', {}));
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dickerdata_get_invoice_details includes the sales order number and optional flags in the query', async () => {
    const creds = { accountCode: 'ACC-INV-3', accessToken: 'tok-inv-3' };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ AccessKey: 'ak-inv-3', ExpireDateTime: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(jsonResponse({ LineItems: [] }));

    await runWithCredentials(creds, () =>
      handleAccountTool('dickerdata_get_invoice_details', {
        salesOrderNumber: 'SO1',
        salesOrderNumberSuffix: 'A',
        includeCustomerQualification: true,
      })
    );

    const url = new URL(fetchMock.mock.calls[1][0] as string);
    expect(url.searchParams.get('request.salesOrderNumber')).toBe('SO1');
    expect(url.searchParams.get('request.salesOrderNumberSuffix')).toBe('A');
    expect(url.searchParams.get('request.includeCustomerQualification')).toBe('true');
  });
});
