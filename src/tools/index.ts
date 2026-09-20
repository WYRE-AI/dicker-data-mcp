import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ACCOUNT_TOOLS, handleAccountTool } from './account.js';
import { ORDER_TOOLS, handleOrderTool } from './orders.js';
import { PRICING_TOOLS, handlePricingTool } from './pricing.js';
import type { CallToolResult } from './types.js';

export const ALL_TOOLS: Tool[] = [...PRICING_TOOLS, ...ORDER_TOOLS, ...ACCOUNT_TOOLS];

const PRICING_NAMES = new Set(PRICING_TOOLS.map((t) => t.name));
const ORDER_NAMES = new Set(ORDER_TOOLS.map((t) => t.name));
const ACCOUNT_NAMES = new Set(ACCOUNT_TOOLS.map((t) => t.name));

export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (PRICING_NAMES.has(name)) return handlePricingTool(name, args);
  if (ORDER_NAMES.has(name)) return handleOrderTool(name, args);
  if (ACCOUNT_NAMES.has(name)) return handleAccountTool(name, args);
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}
