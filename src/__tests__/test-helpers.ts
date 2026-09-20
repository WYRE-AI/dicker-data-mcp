import type { CallToolResult } from '../tools/types.js';

/** Extracts the text of the first content block, failing loudly if it isn't text. */
export function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') {
    throw new Error(`Expected a text content block, got: ${JSON.stringify(block)}`);
  }
  return block.text;
}
