import { z } from 'zod';
import { READ_TOOLS } from './policy.js';
import { definition, observation, workspace } from './knowledge/model.js';

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

// Product attributes are account-defined; validate the stable surrounding shape
// while preserving all returned fields and their original values.
const productRecord = z.object({ id: z.string(), sku: z.string().optional(), label: z.string().optional() }).passthrough();
const pagination = z.object({
  page: z.number().int().nonnegative().optional(), page_size: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(), pages: z.number().int().nonnegative().optional(),
  count: z.number().int().nonnegative().optional(), total_count: z.number().int().nonnegative().optional(),
  order: z.string().nullable().optional(),
}).passthrough();
const candidate = z.object({
  id: z.string(), sku: z.string().optional(), label: z.string().optional(), confidence: z.number().min(0).max(1),
});
const knowledgePage = z.object({
  page: z.number().int().positive(), page_size: z.number().int().positive(),
  total: z.number().int().nonnegative(), has_more: z.boolean(),
});
export const toolDataSchemas: Record<string, z.ZodTypeAny> = {
  products_lookup: z.object({
    selected: candidate.extend({ reason: z.string(), matchedField: z.string() }).nullable(),
    product: productRecord.nullable(), alternativeMatches: z.array(candidate), searchPlan: z.array(z.string()),
    partial: z.boolean().optional(),
    retrieval: z.object({
      status: z.enum(['available', 'unavailable', 'not_requested']),
      source: z.enum(['product_detail', 'search_record', 'none']),
    }),
  }),
  products_search: z.object({
    products: z.array(productRecord), pagination: pagination.optional(), attributes_returned: z.array(z.string()).optional(),
  }),
  catalog_dictionary: z.object({
    workspace: workspace.nullable(), revision: z.number().int().nonnegative().nullable(),
    definitions: z.array(definition), definitions_pagination: knowledgePage,
    observations: z.array(observation), observations_pagination: knowledgePage,
    live_schema: z.discriminatedUnion('status', [
      z.object({ status: z.literal('available'), attributes: z.array(z.object({
        id: z.string(), name: z.string(), label: z.string(), type_class: z.string(),
      }).passthrough()), pagination: pagination.nullable() }),
      z.object({ status: z.literal('unavailable'), attributes: z.null() }),
    ]).nullable(),
    live_requested: z.boolean(), partial: z.boolean(), notes: z.array(z.string()),
  }),
};

export function outputSchemaForTool(name: string) {
  const schema = toolDataSchemas[name];
  return schema ? { data: z.union([schema, z.object({ message: z.string() }).strict()]), metadata: resultMetadataSchema } : outputSchema;
}

export function parseResult(result: ToolResult): unknown {
  const text = result.content[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { message: text }; }
}
export function decorateResult(name: string, result: ToolResult, started: string, sources: ReadEvidence[]) {
  const data = parseResult(result);
  if (!result.isError && toolDataSchemas[name] && !toolDataSchemas[name].safeParse(data).success) {
    // Do not expose validation issues: upstream values may contain private data.
    return decorateResult(name, {
      content: [{ type: 'text', text: 'Tool result did not match its output contract.' }], isError: true,
    }, started, sources);
  }
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
    name === 'server_capabilities' || name === 'discovery_guide' || name === 'catalog_workspace';
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
