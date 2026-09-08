/**
 * @fileoverview Server-specific environment configuration for
 * sanctions-screening-mcp-server. Holds the local mirror path, fuzzy-match
 * tuning, the refresh cron, and per-source URL overrides. All sources are
 * keyless — the EU "token" is a static public path component, not a credential
 * — so no secret values live here.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Default upstream source endpoints, all verified official paths (see docs/design.md). */
export const DEFAULT_SOURCE_URLS = {
  ofacSdn:
    'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML',
  ofacConsolidated:
    'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_ADVANCED.XML',
  euFsf:
    'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
  ukSanctions: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml',
  unSc: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
  bisEntity: '',
  bisDpl: '',
  bisUnverified: '',
  gleifGoldenCopyBase: 'https://goldencopy.gleif.org',
} as const;

const ServerConfigSchema = z.object({
  mirrorPath: z
    .string()
    .default('./data/sanctions.db')
    .describe('Filesystem path for the SQLite mirror; a persistent volume on a hosted deployment.'),
  refreshCron: z
    .string()
    .default('0 4 * * *')
    .describe(
      'Cron for the scheduled refresh of the sanctions lists + name index (HTTP transport only). GLEIF deltas are not applied on the cron — refresh them manually with mirror:refresh.',
    ),
  restHttpPort: z.coerce
    .number()
    .int()
    .min(0)
    .max(65535)
    .default(0)
    .describe('Public REST port; 0 uses MCP_HTTP_PORT + 1.'),
  restMcpProxyHost: z
    .string()
    .default('127.0.0.1')
    .describe('Internal host used by the REST facade to proxy /mcp requests.'),
  fuzzyMinScore: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.85)
    .describe('Default Jaro-Winkler similarity floor for fuzzy matches when min_score is omitted.'),
  fuzzyMaxResults: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .describe('Hard cap on fuzzy candidates scored per query, to bound work on short queries.'),
  ofacSdnUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.ofacSdn)
    .describe('OFAC SDN advanced-XML URL.'),
  ofacConsolidatedUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.ofacConsolidated)
    .describe('OFAC Consolidated advanced-XML URL.'),
  euFsfUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.euFsf)
    .describe('EU consolidated XML URL (includes the static public token path component).'),
  ukSanctionsUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.ukSanctions)
    .describe('UK Sanctions List (UKSL) XML URL.'),
  unScUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.unSc)
    .describe('UN Security Council consolidated XML URL.'),
  bisEntityUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.bisEntity)
    .describe('Optional US BIS Entity List CSV URL. Leave empty to disable this source.'),
  bisDplUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.bisDpl)
    .describe(
      'Optional US BIS Denied Persons List (DPL) CSV URL. Leave empty to disable this source.',
    ),
  bisUnverifiedUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.bisUnverified)
    .describe('Optional US BIS Unverified List CSV URL. Leave empty to disable this source.'),
  gleifGoldenCopyBaseUrl: z
    .string()
    .default(DEFAULT_SOURCE_URLS.gleifGoldenCopyBase)
    .describe('Base URL for the GLEIF golden-copy / delta download API.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parse and memoize the server config. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mirrorPath: 'SANCTIONS_MIRROR_PATH',
    refreshCron: 'SANCTIONS_REFRESH_CRON',
    restHttpPort: 'REST_HTTP_PORT',
    restMcpProxyHost: 'REST_MCP_PROXY_HOST',
    fuzzyMinScore: 'SANCTIONS_FUZZY_MIN_SCORE',
    fuzzyMaxResults: 'SANCTIONS_FUZZY_MAX_RESULTS',
    ofacSdnUrl: 'OFAC_SDN_URL',
    ofacConsolidatedUrl: 'OFAC_CONSOLIDATED_URL',
    euFsfUrl: 'EU_FSF_URL',
    ukSanctionsUrl: 'UK_SANCTIONS_URL',
    unScUrl: 'UN_SC_URL',
    bisEntityUrl: 'BIS_ENTITY_URL',
    bisDplUrl: 'BIS_DPL_URL',
    bisUnverifiedUrl: 'BIS_UNVERIFIED_URL',
    gleifGoldenCopyBaseUrl: 'GLEIF_GOLDEN_COPY_BASE_URL',
  });
  return _config;
}

/** Reset memoized config — test isolation only. */
export function resetServerConfig(): void {
  _config = undefined;
}
