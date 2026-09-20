import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials, getInvoiceDetails, listInvoices } from '../client.js';
import type { CallToolResult } from './types.js';
import { errorResult, requireCredentials, textResult } from './shared.js';

export const ACCOUNT_TOOLS: Tool[] = [
  {
    name: 'dickerdata_list_invoices',
    description: 'List Dicker Data account invoices within a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start date, e.g. 2026-01-01.' },
        endDate: { type: 'string', description: 'End date, e.g. 2026-01-31.' },
      },
    },
  },
  {
    name: 'dickerdata_get_invoice_details',
    description: 'Get line-item detail for a Dicker Data sales order / invoice.',
    inputSchema: {
      type: 'object',
      properties: {
        salesOrderNumber: { type: 'string' },
        salesOrderNumberSuffix: { type: 'string' },
        includeCustomerQualification: { type: 'boolean' },
      },
      required: ['salesOrderNumber'],
    },
  },
];

export async function handleAccountTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const creds = getCredentials();
  const missing = requireCredentials(creds);
  if (missing) return missing;

  try {
    if (name === 'dickerdata_list_invoices') {
      const result = await listInvoices(creds!, {
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
      });
      return textResult(result);
    }

    if (name === 'dickerdata_get_invoice_details') {
      const salesOrderNumber = args.salesOrderNumber as string;
      if (!salesOrderNumber) return errorResult('salesOrderNumber is required.');
      const result = await getInvoiceDetails(creds!, {
        salesOrderNumber,
        salesOrderNumberSuffix: args.salesOrderNumberSuffix as string | undefined,
        includeCustomerQualification: args.includeCustomerQualification as boolean | undefined,
      });
      return textResult(result);
    }

    return errorResult(`Unknown account tool: ${name}`);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}
