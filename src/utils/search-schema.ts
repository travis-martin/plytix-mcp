import { z } from 'zod';

// The API's filter discovery is authoritative for which operators each field supports.
export const filterOperatorSchema = z.enum([
  'eq', '!eq', 'like', '!like', 'in', '!in', 'gt', 'gte', 'lt', 'lte',
  'exists', '!exists', 'text_search', 'last_days', 'by_in', '!by_in',
]);

export const filterSchema = z.object({
  field: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  operator: filterOperatorSchema,
  value: z.unknown().optional(),
});
