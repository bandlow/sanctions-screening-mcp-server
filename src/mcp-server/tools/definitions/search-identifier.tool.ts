/**
 * @fileoverview `sanctions_search_identifier` — find sanctions designations by
 * published identifiers such as IMO numbers, tax IDs, registration numbers, and
 * passports. This is a drill-in aid for source-published identifiers, not a
 * compliance determination.
 * @module mcp-server/tools/definitions/search-identifier.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES, SOURCE_LABELS } from '@/services/screening/types.js';
import { SCREENING_CAVEAT } from './_shared.js';

const SOURCE_ENUM = z.enum([
  'ofac_sdn',
  'ofac_consolidated',
  'eu',
  'uk',
  'un',
  'us_bis_entity',
  'us_bis_dpl',
  'us_bis_unverified',
]);

const IdentifierHitSchema = z
  .object({
    source: SOURCE_ENUM.describe('Which watchlist this candidate is on — its provenance.'),
    sourceLabel: z.string().describe('Human-readable name of the source list.'),
    sourceEntryId: z
      .string()
      .describe("The list's own entry ID — pass to sanctions_get_designation for the full record."),
    entityType: z
      .enum(['person', 'organization', 'vessel', 'aircraft', 'unknown'])
      .describe('Entity classification as published by the source.'),
    primaryName: z.string().describe('Primary published name of the designated entity.'),
    identifier: z
      .object({
        type: z.string().describe('Identifier category as published by the source.'),
        value: z.string().describe('Identifier value as published by the source.'),
        country: z.string().optional().describe('Issuing country/authority, when published.'),
      })
      .describe('The published identifier that matched the query.'),
    matchType: z
      .enum(['exact', 'contains'])
      .describe(
        'exact = folded identifier value equality; contains = identifier value contains the query.',
      ),
    program: z.string().optional().describe('Sanctioning program / regime, when published.'),
    designationDate: z
      .string()
      .optional()
      .describe('Designation date as published, when available.'),
  })
  .describe('One identifier match — a candidate to verify, never a determination.');

export const searchIdentifierTool = tool('sanctions_search_identifier', {
  title: 'sanctions-screening-mcp-server: search identifier',
  description:
    'Search published sanctions identifiers such as IMO numbers, tax IDs, registration numbers, passports, and national IDs across the loaded OFAC SDN, OFAC Consolidated, EU, UK, and UN watchlists. The query is folded case-insensitively, so "8909575" can match "IMO 8909575". Results are paged and include source provenance plus the sourceEntryId for sanctions_get_designation. This is a screening AID for a human/compliance review, NOT a compliance determination: a hit means "review this candidate against the official source," and an empty result never means "cleared."',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    identifier: z
      .string()
      .min(1)
      .describe(
        'Identifier value to search for, such as an IMO number, tax ID, passport, or registration number.',
      ),
    identifierType: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional identifier category filter, matched case-insensitively by contains, such as "IMO", "Tax", or "Registration".',
      ),
    entityType: z
      .enum(['any', 'person', 'organization', 'vessel', 'aircraft'])
      .default('any')
      .describe('Restrict to one entity class, or "any" (default) to search across all.'),
    sources: z
      .array(SOURCE_ENUM)
      .optional()
      .describe('Restrict to specific source lists. Omit to search all loaded lists.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of identifier matches to return in one page.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first identifier match to return. Re-call with nextOffset when hasMore is true.',
      ),
  }),
  output: z.object({
    hits: z
      .array(IdentifierHitSchema)
      .describe('Published identifier matches, ordered by exactness and stable designation ID.'),
    caveat: z
      .string()
      .describe(
        'Decision-support caveat — this is a screening aid, not a compliance determination.',
      ),
  }),
  enrichment: {
    normalizedQuery: z
      .string()
      .describe('The identifier query as the server folded it for matching.'),
    totalCount: z.number().describe('Number of identifier matches returned in this page.'),
    totalAvailable: z
      .number()
      .describe(
        'Identifier matches available across all pages, before limit and offset were applied.',
      ),
    hasMore: z.boolean().describe('True when identifier matches remain beyond this page.'),
    nextOffset: z
      .number()
      .optional()
      .describe('The offset to request next. Present only when hasMore is true.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no identifier matched or the requested offset sits past the end of the result set.',
      ),
  },
  errors: [
    {
      reason: 'mirror_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The sanctions mirror has never completed an initial sync.',
      retryable: true,
      recovery: 'Run the mirror:init lifecycle script to load the sanctions lists, then retry.',
    },
  ],

  async handler(input, ctx) {
    const svc = getScreeningService();
    if (!(await svc.sanctionsReady())) {
      throw ctx.fail('mirror_not_ready', 'The local sanctions mirror is not yet populated.', {
        ...ctx.recoveryFor('mirror_not_ready'),
      });
    }

    const sources = input.sources && input.sources.length > 0 ? input.sources : [...SOURCE_CODES];
    const result = await svc.searchIdentifier({
      query: input.identifier,
      ...(input.identifierType ? { identifierType: input.identifierType } : {}),
      entityType: input.entityType,
      sources,
      limit: input.limit,
      offset: input.offset,
    });

    const hasMore = input.offset + result.hits.length < result.totalAvailable;
    ctx.enrich({
      normalizedQuery: result.normalizedQuery,
      totalAvailable: result.totalAvailable,
      hasMore,
      ...(hasMore ? { nextOffset: input.offset + result.hits.length } : {}),
    });
    ctx.enrich.total(result.hits.length);
    if (result.totalAvailable === 0) {
      ctx.enrich.notice(
        `No published identifier matched "${input.identifier}" across the selected lists. This is NOT a clearance — verify directly against the official source when needed.`,
      );
    } else if (result.hits.length === 0) {
      ctx.enrich.notice(
        `Offset ${input.offset} is past the end of this identifier result set — ${result.totalAvailable} match(es) are available. Re-request from offset 0 and page forward with nextOffset.`,
      );
    }

    return {
      hits: result.hits.map((hit) => ({
        source: hit.source,
        sourceLabel: SOURCE_LABELS[hit.source],
        sourceEntryId: hit.sourceEntryId,
        entityType: hit.entityType,
        primaryName: hit.primaryName,
        identifier: hit.identifier,
        matchType: hit.matchType,
        ...(hit.program ? { program: hit.program } : {}),
        ...(hit.designationDate ? { designationDate: hit.designationDate } : {}),
      })),
      caveat: SCREENING_CAVEAT,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.hits.length === 0) {
      lines.push('**No published identifier matches found.**');
    } else {
      lines.push(
        `**${result.hits.length} identifier match(es)** — candidates to verify, not determinations:\n`,
      );
      for (const hit of result.hits) {
        const country = hit.identifier.country ? ` (${hit.identifier.country})` : '';
        lines.push(`### ${hit.primaryName} — ${hit.matchType}`);
        lines.push(`**Identifier:** ${hit.identifier.type}: ${hit.identifier.value}${country}`);
        lines.push(
          `**List:** ${hit.sourceLabel} (\`${hit.source}\`) | **Entry ID:** ${hit.sourceEntryId} | **Type:** ${hit.entityType}`,
        );
        if (hit.program) lines.push(`**Program:** ${hit.program}`);
        if (hit.designationDate) lines.push(`**Designated:** ${hit.designationDate}`);
        lines.push('');
      }
    }
    lines.push(`> ${result.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
