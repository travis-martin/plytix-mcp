import { z } from 'zod';
import { READ_TOOLS } from './policy.js';

export interface ReadEvidence {
  source: string;
  observed_at: string;
  cached?: boolean;
}
export const resultMetadataSchema = z.object({
  schema_version: z.literal(1),
  tool: z.string(),
  generated_at: z.string(),
  status: z.enum(['ok', 'partial', 'error']),
  source: z.enum(['plytix', 'local', 'shared_knowledge', 'mixed']),
  freshness: z.enum(['live', 'cached', 'mixed', 'not_applicable', 'not_asserted']),
  sources: z.array(z.object({ source: z.string(), observed_at: z.string(), cached: z.boolean().optional() })),
  coverage: z.enum(['complete_for_query', 'partial', 'not_asserted']),
  pagination: z.unknown().optional(),
  error_code: z.string().optional(),
  retryable: z.boolean().optional(),
  warnings: z.array(z.string()),
  learning: z.object({
    status: z.enum(['stored', 'disabled', 'unavailable']),
    observations: z.number().int().nonnegative().optional(),
    revision: z.number().int().nonnegative().optional(),
  }).optional(),
});
export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  resultMetadata?: Partial<z.infer<typeof resultMetadataSchema>>;
}
export const outputSchema = { data: z.unknown(), metadata: resultMetadataSchema };

export function parseResult(result: ToolResult): unknown {
  const text = result.content[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { message: text }; }
}
export function decorateResult(name: string, result: ToolResult, started: string, sources: ReadEvidence[]) {
  const data = parseResult(result);
  const object = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, any> : {};
  const errorText = result.isError ? result.content.map(item => item.text).join(' ') : '';
  const errorCode = /HTTP 403/.test(errorText) ? 'access_denied'
    : /HTTP 401/.test(errorText) ? 'authentication_failed'
    : /HTTP 429/.test(errorText) ? 'rate_limited'
    : /cancel|timeout|timed out/i.test(errorText) ? 'cancelled_or_timed_out'
    : /approval|approved/i.test(errorText) ? 'approval_required' : 'tool_failed';
  const partial = object.partial === true || object.complete === false ||
    object.scope?.complete_for_query === false || object.coverage?.complete_for_query === false;
  const observed = sources.map(item => !item.cached && item.observed_at >= started);
  const local = name.startsWith('identifier_') || name === 'match_score' ||
    name === 'server_capabilities' || name === 'discovery_guide';
  const metadata = resultMetadataSchema.parse({
    schema_version: 1, tool: name, generated_at: new Date().toISOString(),
    status: result.isError ? 'error' : partial ? 'partial' : 'ok',
    source: sources.length ? 'plytix' : local ? 'local' :
      name.startsWith('knowledge_') ? 'shared_knowledge' : name === 'catalog_dictionary' ? 'mixed' : 'plytix',
    freshness: sources.length ? observed.every(Boolean) ? 'live' : observed.some(Boolean) ? 'mixed' : 'cached'
      : local ? 'not_applicable' : 'not_asserted',
    sources,
    coverage: partial ? 'partial'
      : object.scope?.complete_for_query === true || object.coverage?.complete_for_query === true
        ? 'complete_for_query' : 'not_asserted',
    ...(object.pagination ? { pagination: object.pagination } : {}),
    ...(result.isError ? { error_code: errorCode, retryable: errorCode === 'rate_limited' && READ_TOOLS.has(name) } : {}),
    warnings: [],
    ...result.resultMetadata,
    // Handlers cannot make an error look successful.
    ...(result.isError ? { status: 'error' } : {}),
  });
  return {
    // Preserve the original first text block for existing integrations.
    content: [...result.content, { type: 'text', text: `Result metadata: ${JSON.stringify(metadata)}` }],
    structuredContent: { data, metadata },
    ...(result.isError ? { isError: true } : {}),
  };
}
