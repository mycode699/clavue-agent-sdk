/**
 * Content block types and provider re-exports.
 * Provider-agnostic, compatible with Anthropic format.
 */

export type ImageSource = import('../providers/types.js').NormalizedImageSource

/** Re-export of the provider-level structured output schema. */
export type OutputSchema = import('../providers/types.js').OutputSchema

export type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | any[]; is_error?: boolean }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }

// Output format
export interface OutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}
