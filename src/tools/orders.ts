import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  getConsignmentStatus,
  getCredentials,
  getOrderDetails,
  getOrderDetailsList,
  getOrderSerials,
} from '../client.js';
import type { CallToolResult } from './types.js';
import { errorResult, requireCredentials, textResult } from './shared.js';

/**
 * dickerdata_create_order is gated (WYREAI-592): /api/Order/CreateOrder now
 * returns 401 "Missing Request Header/Authorization." and Dicker has not
 * documented which Authorization scheme it expects. Fail loudly instead of
 * attempting the call.
 */
export const CREATE_ORDER_UNAVAILABLE_MESSAGE =
  "dickerdata_create_order is temporarily unavailable: Dicker Data's /api/Order/CreateOrder endpoint now requires an HTTP Authorization header whose scheme Dicker has not documented. No order was placed. Place the order in the Dicker Data portal until this is resolved (WYREAI-592).";

export const ORDER_TOOLS: Tool[] = [
  {
    name: 'dickerdata_create_order',
    description: 'TEMPORARILY UNAVAILABLE (known issue): Always returns an error and places no order because Dicker Data requires an undocumented HTTP Authorization header (WYREAI-592).',
    inputSchema: {
      type: 'object',
      properties: {
        customerPORef: { type: 'string', description: 'Your own purchase-order reference for this order.' },
        notes: { type: 'string', description: 'Order-level notes.' },
        deliveryAttention: { type: 'string', description: 'Attention line for delivery.' },
        deliveryAddress: {
          type: 'object',
          description: 'Delivery address. Omit to ship to the account default address.',
          properties: {
            companyName: { type: 'string' },
            address01: { type: 'string' },
            address02: { type: 'string' },
            suburb: { type: 'string' },
            state: { type: 'string' },
            postcode: { type: 'string' },
            country: { type: 'string' },
          },
        },
        items: {
          type: 'array',
          description: 'Products to order.',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'string', description: 'Dicker Data product/part number.' },
              quantity: { type: 'number', description: 'Quantity to order.' },
              unitPrice: { type: 'string', description: 'Optional price override; omit to use system price.' },
            },
            required: ['partNumber', 'quantity'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'dickerdata_get_order_details',
    description: 'Get details for a single Dicker Data order by order number, account code, or your PO reference.',
    inputSchema: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string' },
        accountCode: { type: 'string' },
        customerPORef: { type: 'string' },
      },
    },
  },
  {
    name: 'dickerdata_list_orders',
    description:
      'List Dicker Data orders matching an account code, order number, backorder number, or customer PO number.',
    inputSchema: {
      type: 'object',
      properties: {
        accountCode: { type: 'string' },
        orderNumber: { type: 'string' },
        backorderNumber: { type: 'string' },
        customerPONumber: { type: 'string' },
      },
    },
  },
  {
    name: 'dickerdata_get_order_serials',
    description: 'Get the shipped serial numbers for a Dicker Data order.',
    inputSchema: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string' },
        orderSuffix: { type: 'string' },
      },
      required: ['orderNumber'],
    },
  },
  {
    name: 'dickerdata_get_consignment_status',
    description: 'Get shipping/tracking status for a Dicker Data consignment number.',
    inputSchema: {
      type: 'object',
      properties: {
        consignmentNumber: { type: 'string' },
      },
      required: ['consignmentNumber'],
    },
  },
];

export async function handleOrderTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (name === 'dickerdata_create_order') return errorResult(CREATE_ORDER_UNAVAILABLE_MESSAGE);

  const creds = getCredentials();
  const missing = requireCredentials(creds);
  if (missing) return missing;

  try {
    if (name === 'dickerdata_get_order_details') {
      const result = await getOrderDetails(creds!, {
        orderNumber: args.orderNumber as string | undefined,
        accountCode: args.accountCode as string | undefined,
        customerPORef: args.customerPORef as string | undefined,
      });
      return textResult(result);
    }

    if (name === 'dickerdata_list_orders') {
      const result = await getOrderDetailsList(creds!, {
        accountCode: args.accountCode as string | undefined,
        orderNumber: args.orderNumber as string | undefined,
        backorderNumber: args.backorderNumber as string | undefined,
        customerPONumber: args.customerPONumber as string | undefined,
      });
      return textResult(result);
    }

    if (name === 'dickerdata_get_order_serials') {
      const orderNumber = args.orderNumber as string;
      if (!orderNumber) return errorResult('orderNumber is required.');
      const result = await getOrderSerials(creds!, orderNumber, args.orderSuffix as string | undefined);
      return textResult(result);
    }

    if (name === 'dickerdata_get_consignment_status') {
      const consignmentNumber = args.consignmentNumber as string;
      if (!consignmentNumber) return errorResult('consignmentNumber is required.');
      const result = await getConsignmentStatus(creds!, consignmentNumber);
      return textResult(result);
    }

    return errorResult(`Unknown order tool: ${name}`);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}
