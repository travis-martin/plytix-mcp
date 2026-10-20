import { z } from 'zod';

/** Safe, fixed messages only; never attach raw file/credential/validation data. */
export class KnowledgeError extends Error {}

export const definitionInput = z.object({
  term: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
  meaning: z.string().trim().min(1).max(3000),
  attribute_labels: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(30).default([]),
  family_ids: z.array(z.string().min(1).max(160)).max(30).default([]),
  evidence: z.string().trim().min(1).max(1500),
}).strict();
export type DefinitionInput = z.infer<typeof definitionInput>;
export const definition = definitionInput.extend({
  id: z.string().uuid(),
  status: z.enum(['proposed', 'confirmed', 'rejected', 'retired']),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  proposed_by: z.string().min(1).max(160),
  reviewed_by: z.string().max(160).optional(),
  review_note: z.string().max(1500).optional(),
});
export type Definition = z.infer<typeof definition>;

// Only structural metadata is retained. Product values and arbitrary upstream
// properties are never copied into the shared store.
export const observation = z.object({
  label: z.string().min(1).max(200),
  id: z.string().max(200),
  name: z.string().max(500),
  type_class: z.string().max(200),
  groups: z.array(z.string().max(200)).max(100).optional(),
  options: z.array(z.string().max(1000)).max(500).optional(),
  options_truncated: z.boolean().optional(),
  observed_at: z.string().datetime(),
  source: z.literal('plytix_attribute_schema'),
  observed_by: z.string().max(160),
  previous_type: z.string().max(200).optional(),
});
export type Observation = z.infer<typeof observation>;

export const knowledgeDocument = z.object({
  version: z.literal(1),
  scope_id: z.string().min(1).max(160),
  revision: z.number().int().nonnegative(),
  definitions: z.array(definition).max(2000),
  observations: z.array(observation).max(10000),
}).strict();
export type KnowledgeDocument = z.infer<typeof knowledgeDocument>;

export const workspace = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  domain: z.string().max(253).optional(),
  plytix_account_id: z.string().max(160).optional(),
  learn_observations: z.boolean().default(false),
}).strict();
export type Workspace = z.infer<typeof workspace>;
export const registrySchema = z.object({
  version: z.literal(1),
  workspaces: z.array(workspace).max(1000),
  bindings: z.array(z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    scope_id: z.string().min(1).max(160),
    member: z.string().min(1).max(160),
    can_propose: z.boolean().default(false),
  }).strict()).max(10000),
}).strict().superRefine((value, context) => {
  const ids = value.workspaces.map(item => item.id);
  const fingerprints = value.bindings.map(item => item.fingerprint);
  if (new Set(ids).size !== ids.length || new Set(fingerprints).size !== fingerprints.length ||
    value.bindings.some(item => !ids.includes(item.scope_id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid workspace bindings' });
  }
});
export type Registry = z.infer<typeof registrySchema>;
