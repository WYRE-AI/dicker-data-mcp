import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials, getPrice, getPricing } from '../client.js';
import type { CallToolResult } from './types.js';
import { errorResult, requireCredentials, textResult } from './shared.js';

export const PRICING_TOOLS: Tool[] = [
  {
    name: 'dickerdata_get_pricing',
    description:
      'Look up Dicker Data PricingRequest price-list (datafeed) pricing and stock-on-hand for one or more product codes. UnitPrice and SOH come from Dicker\'s PricingRequest feed and may lag your live account price and stock; dimensions may be null.',
    inputSchema: {
      type: 'object',
      properties: {
        productCodes: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more Dicker Data product/part numbers to look up price-list pricing and stock for.',
        },
      },
      required: ['productCodes'],
    },
  },
  {
    name: 'dickerdata_get_price',
    description:
      'Look up Dicker Data PricingRequest price-list (datafeed) pricing and stock-on-hand for a single product code. UnitPrice and SOH come from Dicker\'s PricingRequest feed and may lag your live account price and stock; dimensions may be null. No quantity-based pricing (PricingRequest has no quantity field). Currently uses the same PricingRequest feed as dickerdata_get_pricing, not Dicker\'s live GetPrice endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        productCode: { type: 'string', description: 'The Dicker Data product/part number to price.' },
      },
      required: ['productCode'],
    },
  },
];

export async function handlePricingTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const creds = getCredentials();
  const missing = requireCredentials(creds);
  if (missing) return missing;

  try {
    if (name === 'dickerdata_get_pricing') {
      const productCodes = args.productCodes as string[];
      if (!Array.isArray(productCodes) || productCodes.length === 0) {
        return errorResult('productCodes must be a non-empty array of product codes.');
      }
      const result = await getPricing(creds!, productCodes);
      return textResult(result);
    }

    if (name === 'dickerdata_get_price') {
      const productCode = args.productCode as string;
      if (!productCode) return errorResult('productCode is required.');
      const result = await getPrice(creds!, productCode);
      return textResult(result);
    }

    return errorResult(`Unknown pricing tool: ${name}`);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}
