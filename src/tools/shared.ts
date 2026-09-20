import type { DickerDataCredentials } from '../types.js';
import type { CallToolResult } from './types.js';

export function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Returns an error CallToolResult if credentials are missing, else null. */
export function requireCredentials(creds: DickerDataCredentials | null): CallToolResult | null {
  if (!creds) {
    return errorResult(
      'No Dicker Data credentials configured. Set DICKERDATA_ACCOUNT_CODE and DICKERDATA_ACCESS_TOKEN.'
    );
  }
  return null;
}
