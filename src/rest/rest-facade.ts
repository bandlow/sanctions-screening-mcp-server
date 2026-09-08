/**
 * @fileoverview REST facade for classical SAP/CAP backend integration. Exposes
 * stable HTTP endpoints over the existing screening engine (no duplicate
 * business logic): name screening for business partners and source freshness.
 *
 * The facade starts only on HTTP transport and listens on `MCP_HTTP_PORT + 1`
 * to avoid colliding with the MCP endpoint.
 * @module rest/rest-facade
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ContextLogger, z } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import {
  GLEIF_LICENSE,
  GLEIF_SOURCE_LABEL,
  gleifSourceUrl,
  SCREENING_CAVEAT,
  SOURCE_LICENSES,
  sourceUrls,
} from '@/mcp-server/tools/definitions/_shared.js';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES, SOURCE_LABELS, type SourceCode } from '@/services/screening/types.js';

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

const BusinessPartnerScreenRequestSchema = z
  .object({
    bpId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional external business partner identifier from SAP.'),
    name: z.string().min(1).describe('Business partner name to screen.'),
    country: z
      .string()
      .length(2)
      .optional()
      .describe('Optional ISO 3166-1 alpha-2 country code from the source system.'),
    role: z
      .enum(['customer', 'vendor', 'other'])
      .optional()
      .describe('Optional business role from the source system.'),
    entityType: z
      .enum(['any', 'person', 'organization', 'vessel', 'aircraft'])
      .default('any')
      .describe('Entity-type restriction forwarded to the screening engine.'),
    matchMode: z
      .enum(['strict', 'fuzzy'])
      .default('strict')
      .describe('Matching mode: strict first, fuzzy optional/fallback.'),
    minScore: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Optional fuzzy similarity floor (0-1).'),
    sources: z
      .array(SOURCE_ENUM)
      .optional()
      .describe('Optional source-list subset. Omit to screen across all lists.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum hits to return.'),
    offset: z.number().int().min(0).default(0).describe('Zero-based pagination offset.'),
  })
  .strict();

const BatchScreenRequestSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            bpId: z.string().min(1).optional(),
            name: z.string().min(1),
            country: z.string().length(2).optional(),
            role: z.enum(['customer', 'vendor', 'other']).optional(),
          })
          .strict(),
      )
      .min(1),
    screening: z
      .object({
        entityType: z.enum(['any', 'person', 'organization', 'vessel', 'aircraft']).default('any'),
        matchMode: z.enum(['strict', 'fuzzy']).default('strict'),
        minScore: z.number().min(0).max(1).optional(),
        sources: z.array(SOURCE_ENUM).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      })
      .optional(),
  })
  .strict();

const SapIntegrationScreeningSchema = z
  .object({
    entityType: z.enum(['any', 'person', 'organization', 'vessel', 'aircraft']).default('any'),
    matchMode: z.enum(['strict', 'fuzzy']).default('strict'),
    minScore: z.number().min(0).max(1).optional(),
    sources: z.array(SOURCE_ENUM).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .optional();

const SapBusinessPartnerSchema = z
  .object({
    bpId: z.string().min(1),
    name: z.string().min(1),
    country: z.string().length(2).optional(),
    role: z.enum(['customer', 'vendor', 'other']).optional(),
  })
  .strict();

const SapEccBusinessPartnerChangedRequestSchema = z
  .object({
    sourceSystem: z.literal('ecc'),
    triggerType: z
      .enum(['badi', 'change_document', 'manual'])
      .describe('ECC trigger category for traceability.'),
    businessPartner: SapBusinessPartnerSchema,
    screening: SapIntegrationScreeningSchema,
    context: z
      .object({
        changeDocumentId: z.string().min(1).optional(),
        iflowMessageId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();

const SapS4BusinessPartnerChangedRequestSchema = z
  .object({
    sourceSystem: z.literal('s4hana'),
    eventType: z.string().min(1).describe('S/4HANA business event type from Event Mesh.'),
    eventId: z.string().min(1).optional(),
    businessPartner: SapBusinessPartnerSchema,
    screening: SapIntegrationScreeningSchema,
    context: z
      .object({
        communicationArrangement: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();

const SapBatchBusinessPartnersRequestSchema = z
  .object({
    sourceSystem: z.enum(['ecc', 's4hana']),
    triggeredBy: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    items: z.array(SapBusinessPartnerSchema).min(1),
    screening: SapIntegrationScreeningSchema,
  })
  .strict();

const CreateExceptionRequestSchema = z
  .object({
    sourceEntryId: z.string().min(1),
    justification: z.string().min(1),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
  })
  .strict();

const CaseDecisionRequestSchema = z
  .object({
    decision: z.enum(['confirmed_match', 'false_positive', 'escalate']),
    decidedBy: z.string().min(1),
    proposedBy: z.string().min(1).optional(),
    approvedBy: z.string().min(1).optional(),
    comment: z.string().min(1).optional(),
  })
  .strict();

type BusinessPartnerScreenRequest = z.infer<typeof BusinessPartnerScreenRequestSchema>;

type ScreeningResponseBody = {
  businessPartner: {
    bpId?: string;
    name: string;
    country?: string;
    role?: 'customer' | 'vendor' | 'other';
  };
  screening: {
    normalizedQuery: string;
    requestedMatchMode: 'strict' | 'fuzzy';
    matchModeUsed: 'strict' | 'fuzzy';
    entityType: 'any' | 'person' | 'organization' | 'vessel' | 'aircraft';
    minScore?: number;
    sources: Array<z.infer<typeof SOURCE_ENUM>>;
    sourcesAsOf?: string;
  };
  pagination: {
    limit: number;
    offset: number;
    returned: number;
    totalAvailable: number;
    totalAvailableBasis: string;
    hasMore: boolean;
    nextOffset?: number;
  };
  hits: Array<Record<string, unknown>>;
  notice?: string;
  caveat: string;
};

type StoredScreeningEvent = {
  eventId: string;
  bpId: string;
  queryName: string;
  matchMode: 'strict' | 'fuzzy';
  matchModeUsed: 'strict' | 'fuzzy';
  entityType: 'any' | 'person' | 'organization' | 'vessel' | 'aircraft';
  sourcesQueried: string[];
  sourcesAsOf?: string;
  executedAt: string;
  hitCount: number;
  screeningStatus: 'screened' | 'not_ready' | 'error';
};

type StoredException = {
  exceptionId: string;
  sourceEntryId: string;
  justification: string;
  validFrom?: string;
  validUntil?: string;
  status: 'active';
  createdAt: string;
};

type StoredCaseHit = {
  hitId: string;
  source: string;
  sourceEntryId: string;
  matchedName: string;
  matchType: 'exact' | 'strong' | 'approximate';
  score?: number;
  reviewStatus: 'open' | 'confirmed_match' | 'false_positive' | 'escalated';
};

type StoredCaseDecision = {
  decisionId: string;
  decision: 'confirmed_match' | 'false_positive' | 'escalate';
  decidedBy: string;
  proposedBy: string;
  approvedBy?: string;
  comment?: string;
  requiresFourEyes: boolean;
  approvalStatus: 'not_required' | 'pending' | 'approved';
  decidedAt: string;
};

type StoredComplianceCase = {
  caseId: string;
  bpId: string;
  businessPartnerName: string;
  status: 'open' | 'in_review' | 'pending_approval' | 'closed';
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
  latestEventId: string;
  eventIds: string[];
  hits: StoredCaseHit[];
  decisions: StoredCaseDecision[];
};

let restServer: Server | undefined;
const DEFAULT_REST_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const historyByBpId = new Map<string, StoredScreeningEvent[]>();
const exceptionsByBpId = new Map<string, StoredException[]>();
const complianceCasesById = new Map<string, StoredComplianceCase>();
const complianceCaseIdsByBpId = new Map<string, string[]>();
const OPENAPI_SPEC_PATHS = [
  resolve(process.cwd(), 'docs', 'rest-facade-openapi.yaml'),
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'rest-facade-openapi.yaml'),
];
const SWAGGER_UI_DIST_PATH = createRequire(import.meta.url)('swagger-ui-dist').getAbsoluteFSPath();

/** Start the REST facade when running on HTTP transport. Idempotent per process. */
export async function startRestFacade(): Promise<void> {
  if (config.mcpTransportType !== 'http') return;
  if (restServer) return;

  const restPort = config.mcpHttpPort + 1;
  if (restPort > 65535) {
    throw new Error(
      `Cannot start REST facade because MCP_HTTP_PORT is ${config.mcpHttpPort}, so MCP_HTTP_PORT + 1 exceeds 65535.`,
    );
  }

  const server = createServer((req, res) => {
    void routeRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(restPort, config.mcpHttpHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  restServer = server;
  logger.info(
    `REST facade listening on http://${config.mcpHttpHost}:${restPort}/api/v1 (MCP remains on ${config.mcpHttpEndpointPath}).`,
    requestContextService.createRequestContext({
      operation: 'rest.facade.start',
    }),
  );
}

/** Stop the REST facade and clear in-process REST state. Safe to call repeatedly. */
export async function stopRestFacade(): Promise<void> {
  if (!restServer) {
    clearRestState();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    restServer?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  restServer = undefined;
  clearRestState();
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = readRequestId(req);
  const reqLog = createRequestLogger('rest.facade.request', requestId);

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      writeNoContent(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/sources') {
      await handleListSources(res);
      return;
    }

    const designationMatch = matchDesignationPath(url.pathname);
    if (req.method === 'GET' && designationMatch) {
      await handleGetDesignation(designationMatch.source, designationMatch.entryId, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/openapi.yaml') {
      await handleOpenApiYaml(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ui/swagger') {
      writeHtml(res, 200, renderSwaggerUiHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ui/swagger-ui.css') {
      await handleSwaggerAsset('swagger-ui.css', 'text/css; charset=utf-8', res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ui/swagger-ui-bundle.js') {
      await handleSwaggerAsset(
        'swagger-ui-bundle.js',
        'application/javascript; charset=utf-8',
        res,
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ui/compliance-cases') {
      writeHtml(res, 200, renderComplianceCasesUiHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/compliance/cases') {
      handleListComplianceCases(url, res);
      return;
    }

    const complianceCaseMatch = matchComplianceCasePath(url.pathname);
    if (req.method === 'GET' && complianceCaseMatch) {
      handleGetComplianceCase(complianceCaseMatch.caseId, res);
      return;
    }

    const complianceCaseDecisionMatch = matchComplianceCaseDecisionPath(url.pathname);
    if (req.method === 'POST' && complianceCaseDecisionMatch) {
      await handleDecideComplianceCase(complianceCaseDecisionMatch.caseId, req, res);
      return;
    }

    const historyMatch = matchBpHistoryPath(url.pathname);
    if (req.method === 'GET' && historyMatch) {
      handleBusinessPartnerHistory(historyMatch.bpId, url, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/screening/batch') {
      await handleScreeningBatch(req, res, reqLog);
      return;
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/api/v1/integration/sap/ecc/business-partner-changed'
    ) {
      await handleSapEccBusinessPartnerChanged(req, res, reqLog);
      return;
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/api/v1/integration/sap/s4/business-partner-changed'
    ) {
      await handleSapS4BusinessPartnerChanged(req, res, reqLog);
      return;
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/api/v1/integration/sap/batch-business-partners'
    ) {
      await handleSapBatchBusinessPartners(req, res, reqLog);
      return;
    }

    const exceptionMatch = matchExceptionsPath(url.pathname);
    if (req.method === 'GET' && exceptionMatch) {
      handleListExceptions(exceptionMatch.bpId, res);
      return;
    }

    if (req.method === 'POST' && exceptionMatch) {
      await handleCreateException(exceptionMatch.bpId, req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/screening/business-partner') {
      await handleBusinessPartnerScreen(req, res, reqLog);
      return;
    }

    writeJson(res, 404, {
      error: {
        code: 'not_found',
        message: `No REST route for ${req.method ?? 'UNKNOWN'} ${url.pathname}.`,
      },
    });
  } catch (error) {
    reqLog.error('REST facade request failed', toError(error));
    writeJson(res, 500, {
      error: {
        code: 'internal_error',
        message: 'Unexpected REST facade error.',
      },
    });
  }
}

async function handleListSources(res: ServerResponse): Promise<void> {
  const svc = getScreeningService();
  const [counts, sanctions, lei] = await Promise.all([
    svc.sourceCounts(),
    svc.sanctionsReadiness(),
    svc.leiReadiness(),
  ]);

  const urlFor = sourceUrls();
  const sources: Array<{
    code: string;
    label: string;
    recordCount: number;
    url: string;
    license: string;
  }> = counts.map((source) => {
    const code = source.code as SourceCode;
    return {
      code,
      label: SOURCE_LABELS[code],
      recordCount: source.recordCount,
      url: urlFor[code],
      license: SOURCE_LICENSES[code],
    };
  });

  sources.push({
    code: 'gleif',
    label: GLEIF_SOURCE_LABEL,
    recordCount: lei.entityCount,
    url: gleifSourceUrl(),
    license: GLEIF_LICENSE,
  });

  writeJson(res, 200, {
    sanctionsReady: sanctions.ready,
    ...(sanctions.completedAt ? { sanctionsAsOf: sanctions.completedAt } : {}),
    leiReady: lei.ready,
    ...(lei.completedAt ? { leiAsOf: lei.completedAt } : {}),
    sources,
  });
}

async function handleOpenApiYaml(res: ServerResponse): Promise<void> {
  for (const specPath of OPENAPI_SPEC_PATHS) {
    try {
      const spec = await readFile(specPath, 'utf8');
      writeText(res, 200, spec, 'application/yaml; charset=utf-8');
      return;
    } catch {}
  }

  writeJson(res, 500, {
    error: {
      code: 'openapi_unavailable',
      message: 'OpenAPI specification file is not available at docs/rest-facade-openapi.yaml.',
    },
  });
}

async function handleSwaggerAsset(
  fileName: string,
  contentType: string,
  res: ServerResponse,
): Promise<void> {
  try {
    const asset = await readFile(join(SWAGGER_UI_DIST_PATH, fileName));
    writeText(res, 200, asset.toString('utf8'), contentType);
  } catch {
    writeJson(res, 500, {
      error: {
        code: 'swagger_ui_unavailable',
        message: `Swagger UI asset ${fileName} is not available.`,
      },
    });
  }
}

async function handleGetDesignation(
  source: SourceCode,
  entryId: string,
  res: ServerResponse,
): Promise<void> {
  const svc = getScreeningService();
  const sanctions = await svc.sanctionsReadiness();
  if (!sanctions.ready) {
    writeJson(res, 503, {
      error: {
        code: 'mirror_not_ready',
        message: 'The local sanctions mirror is not yet populated.',
        recovery:
          'Run the mirror:init lifecycle script to load the sanctions lists, then retry; check /api/v1/sources for readiness.',
      },
    });
    return;
  }

  const designation = await svc.getDesignation(source, entryId);
  if (!designation) {
    writeJson(res, 404, {
      error: {
        code: 'designation_not_found',
        message: `No ${source} designation with entry ID "${entryId}".`,
      },
    });
    return;
  }

  writeJson(res, 200, {
    designation: {
      source: designation.source,
      sourceLabel: SOURCE_LABELS[designation.source],
      sourceEntryId: designation.sourceEntryId,
      entityType: designation.entityType,
      primaryName: designation.primaryName,
      ...(designation.program ? { program: designation.program } : {}),
      ...(designation.legalBasis ? { legalBasis: designation.legalBasis } : {}),
      ...(designation.designationDate ? { designationDate: designation.designationDate } : {}),
      aliases: designation.payload.aliases,
      identifiers: designation.payload.identifiers,
      addresses: designation.payload.addresses,
      datesOfBirth: designation.payload.datesOfBirth,
      nationalities: designation.payload.nationalities,
      ...(designation.payload.vesselDetails
        ? { vesselDetails: designation.payload.vesselDetails }
        : {}),
      ...(designation.payload.remarks ? { remarks: designation.payload.remarks } : {}),
      caveat: SCREENING_CAVEAT,
    },
  });
}

async function handleBusinessPartnerScreen(
  req: IncomingMessage,
  res: ServerResponse,
  reqLog: ContextLogger,
): Promise<void> {
  const payload = await readJsonBodyForRoute(req, res);
  if (payload === undefined) return;

  const parsed = BusinessPartnerScreenRequestSchema.safeParse(payload);
  if (!parsed.success) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: 'Invalid request payload for business-partner screening.',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const input = parsed.data;
  const response = await executeScreening(input, reqLog);
  if ('error' in response) {
    writeJson(res, response.status, {
      error: response.error,
    });
    return;
  }

  recordSuccessfulScreeningSideEffects(input, response.body);

  writeJson(res, 200, response.body);
}

function handleBusinessPartnerHistory(bpId: string, url: URL, res: ServerResponse): void {
  const limit = parsePositiveInt(url.searchParams.get('limit'), 25, 100);
  const offset = parsePositiveInt(url.searchParams.get('offset'), 0, 1_000_000);

  const events = historyByBpId.get(bpId) ?? [];
  const page = events.slice(offset, offset + limit);
  writeJson(res, 200, {
    bpId,
    pagination: {
      limit,
      offset,
      returned: page.length,
      totalAvailable: events.length,
      hasMore: offset + page.length < events.length,
      ...(offset + page.length < events.length ? { nextOffset: offset + page.length } : {}),
    },
    events: page,
  });
}

async function handleScreeningBatch(
  req: IncomingMessage,
  res: ServerResponse,
  reqLog: ContextLogger,
): Promise<void> {
  const payload = await readJsonBodyForRoute(req, res);
  if (payload === undefined) return;

  const parsed = BatchScreenRequestSchema.safeParse(payload);
  if (!parsed.success) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: 'Invalid request payload for screening batch.',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const input = parsed.data;
  const batchId = randomUUID();
  const acceptedAt = new Date().toISOString();

  let processedCount = 0;
  let failedCount = 0;
  for (const item of input.items) {
    const response = await executeScreening(
      {
        bpId: item.bpId,
        name: item.name,
        ...(item.country ? { country: item.country } : {}),
        ...(item.role ? { role: item.role } : {}),
        entityType: input.screening?.entityType ?? 'any',
        matchMode: input.screening?.matchMode ?? 'strict',
        ...(input.screening?.minScore !== undefined ? { minScore: input.screening.minScore } : {}),
        ...(input.screening?.sources ? { sources: input.screening.sources } : {}),
        limit: input.screening?.limit ?? 25,
        offset: 0,
      },
      reqLog,
    );

    if ('error' in response) {
      failedCount += 1;
      if (item.bpId) {
        appendHistoryEvent({
          eventId: randomUUID(),
          bpId: item.bpId,
          queryName: item.name,
          matchMode: input.screening?.matchMode ?? 'strict',
          matchModeUsed: input.screening?.matchMode ?? 'strict',
          entityType: input.screening?.entityType ?? 'any',
          sourcesQueried:
            input.screening?.sources && input.screening.sources.length > 0
              ? input.screening.sources
              : [...SOURCE_CODES],
          executedAt: new Date().toISOString(),
          hitCount: 0,
          screeningStatus: response.error.code === 'mirror_not_ready' ? 'not_ready' : 'error',
        });
      }
      continue;
    }

    processedCount += 1;
    recordSuccessfulScreeningSideEffects(
      {
        bpId: item.bpId,
        name: item.name,
        ...(item.country ? { country: item.country } : {}),
        ...(item.role ? { role: item.role } : {}),
        entityType: input.screening?.entityType ?? 'any',
        matchMode: input.screening?.matchMode ?? 'strict',
        ...(input.screening?.minScore !== undefined ? { minScore: input.screening.minScore } : {}),
        ...(input.screening?.sources ? { sources: input.screening.sources } : {}),
        limit: input.screening?.limit ?? 25,
        offset: 0,
      },
      response.body,
    );
  }

  writeJson(res, 202, {
    batchId,
    status: 'accepted',
    acceptedAt,
    acceptedCount: input.items.length,
    processedCount,
    failedCount,
    note: 'Batch endpoint currently processes immediately in-process and records per-BP history events.',
    caveat: SCREENING_CAVEAT,
  });
}

async function handleSapEccBusinessPartnerChanged(
  req: IncomingMessage,
  res: ServerResponse,
  reqLog: ContextLogger,
): Promise<void> {
  const payload = await readJsonBodyForRoute(req, res);
  if (payload === undefined) return;

  const parsed = SapEccBusinessPartnerChangedRequestSchema.safeParse(payload);
  if (!parsed.success) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: 'Invalid ECC business-partner change payload.',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const body = parsed.data;
  const screeningInput: BusinessPartnerScreenRequest = {
    bpId: body.businessPartner.bpId,
    name: body.businessPartner.name,
    ...(body.businessPartner.country ? { country: body.businessPartner.country } : {}),
    ...(body.businessPartner.role ? { role: body.businessPartner.role } : {}),
    entityType: body.screening?.entityType ?? 'any',
    matchMode: body.screening?.matchMode ?? 'strict',
    ...(body.screening?.minScore !== undefined ? { minScore: body.screening.minScore } : {}),
    ...(body.screening?.sources ? { sources: body.screening.sources } : {}),
    limit: body.screening?.limit ?? 25,
    offset: 0,
  };

  const response = await executeScreening(screeningInput, reqLog);
  if ('error' in response) {
    writeJson(res, response.status, {
      error: response.error,
    });
    return;
  }

  recordSuccessfulScreeningSideEffects(screeningInput, response.body);

  writeJson(res, 200, {
    integration: {
      sourceSystem: 'ecc',
      triggerType: body.triggerType,
      mode: 'realtime',
      receivedAt: new Date().toISOString(),
      ...(body.context ? { context: body.context } : {}),
    },
    result: response.body,
  });
}

async function handleSapS4BusinessPartnerChanged(
  req: IncomingMessage,
  res: ServerResponse,
  reqLog: ContextLogger,
): Promise<void> {
  const payload = await readJsonBodyForRoute(req, res);
  if (payload === undefined) return;

  const parsed = SapS4BusinessPartnerChangedRequestSchema.safeParse(payload);
  if (!parsed.success) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: 'Invalid S/4 business-partner event payload.',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const body = parsed.data;
  const screeningInput: BusinessPartnerScreenRequest = {
    bpId: body.businessPartner.bpId,
    name: body.businessPartner.name,
    ...(body.businessPartner.country ? { country: body.businessPartner.country } : {}),
    ...(body.businessPartner.role ? { role: body.businessPartner.role } : {}),
    entityType: body.screening?.entityType ?? 'any',
    matchMode: body.screening?.matchMode ?? 'strict',
    ...(body.screening?.minScore !== undefined ? { minScore: body.screening.minScore } : {}),
    ...(body.screening?.sources ? { sources: body.screening.sources } : {}),
    limit: body.screening?.limit ?? 25,
    offset: 0,
  };

  const response = await executeScreening(screeningInput, reqLog);
  if ('error' in response) {
    writeJson(res, response.status, {
      error: response.error,
    });
    return;
  }

  recordSuccessfulScreeningSideEffects(screeningInput, response.body);

  writeJson(res, 200, {
    integration: {
      sourceSystem: 's4hana',
      eventType: body.eventType,
      ...(body.eventId ? { eventId: body.eventId } : {}),
      mode: 'realtime',
      receivedAt: new Date().toISOString(),
      ...(body.context ? { context: body.context } : {}),
    },
    result: response.body,
  });
}

async function handleSapBatchBusinessPartners(
  req: IncomingMessage,
  res: ServerResponse,
  reqLog: ContextLogger,
): Promise<void> {
  const payload = await readJsonBodyForRoute(req, res);
  if (payload === undefined) return;

  const parsed = SapBatchBusinessPartnersRequestSchema.safeParse(payload);
  if (!parsed.success) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: 'Invalid SAP batch payload.',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const input = parsed.data;
  const batchId = input.runId ?? randomUUID();
  const acceptedAt = new Date().toISOString();

  let processedCount = 0;
  let failedCount = 0;
  const failedItems: Array<{ bpId: string; reason: string; code: string }> = [];

  for (const item of input.items) {
    const screeningInput: BusinessPartnerScreenRequest = {
      bpId: item.bpId,
      name: item.name,
      ...(item.country ? { country: item.country } : {}),
      ...(item.role ? { role: item.role } : {}),
      entityType: input.screening?.entityType ?? 'any',
      matchMode: input.screening?.matchMode ?? 'strict',
      ...(input.screening?.minScore !== undefined ? { minScore: input.screening.minScore } : {}),
      ...(input.screening?.sources ? { sources: input.screening.sources } : {}),
      limit: input.screening?.limit ?? 25,
      offset: 0,
    };

    const response = await executeScreening(screeningInput, reqLog);
    if ('error' in response) {
      failedCount += 1;
      failedItems.push({
        bpId: item.bpId,
        reason: response.error.message,
        code: response.error.code,
      });
      appendHistoryEvent({
        eventId: randomUUID(),
        bpId: item.bpId,
        queryName: item.name,
        matchMode: input.screening?.matchMode ?? 'strict',
        matchModeUsed: input.screening?.matchMode ?? 'strict',
        entityType: input.screening?.entityType ?? 'any',
        sourcesQueried:
          input.screening?.sources && input.screening.sources.length > 0
            ? input.screening.sources
            : [...SOURCE_CODES],
        executedAt: new Date().toISOString(),
        hitCount: 0,
        screeningStatus: response.error.code === 'mirror_not_ready' ? 'not_ready' : 'error',
      });
      continue;
    }

    processedCount += 1;
    recordSuccessfulScreeningSideEffects(screeningInput, response.body);
  }

  writeJson(res, 202, {
    integration: {
      sourceSystem: input.sourceSystem,
      mode: 'batch',
      ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    },
    batchId,
    status: 'accepted',
    acceptedAt,
    acceptedCount: input.items.length,
    processedCount,
    failedCount,
    failedItems,
    note: 'SAP batch endpoint currently processes immediately in-process and records per-BP history events.',
    caveat: SCREENING_CAVEAT,
  });
}

function handleListExceptions(bpId: string, res: ServerResponse): void {
  const exceptions = exceptionsByBpId.get(bpId) ?? [];
  writeJson(res, 200, {
    bpId,
    exceptions,
  });
}

function handleListComplianceCases(url: URL, res: ServerResponse): void {
  const statusFilter = url.searchParams.get('status');
  const validStatus = new Set(['open', 'in_review', 'pending_approval', 'closed']);
  if (statusFilter && !validStatus.has(statusFilter)) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message:
          "Query parameter 'status' must be one of: open, in_review, pending_approval, closed.",
      },
    });
    return;
  }

  const limit = parsePositiveInt(url.searchParams.get('limit'), 25, 100);
  const offset = parsePositiveInt(url.searchParams.get('offset'), 0, 1_000_000);

  const allCases = [...complianceCasesById.values()]
    .filter((item) => (statusFilter ? item.status === statusFilter : true))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const page = allCases.slice(offset, offset + limit);

  writeJson(res, 200, {
    pagination: {
      limit,
      offset,
      returned: page.length,
      totalAvailable: allCases.length,
      hasMore: offset + page.length < allCases.length,
      ...(offset + page.length < allCases.length ? { nextOffset: offset + page.length } : {}),
    },
    cases: page.map((item) => ({
      caseId: item.caseId,
      bpId: item.bpId,
      businessPartnerName: item.businessPartnerName,
      status: item.status,
      priority: item.priority,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      latestEventId: item.latestEventId,
      hitCount: item.hits.length,
      openHitCount: item.hits.filter((h) => h.reviewStatus === 'open').length,
    })),
  });
}

function handleGetComplianceCase(caseId: string, res: ServerResponse): void {
  const existing = complianceCasesById.get(caseId);
  if (!existing) {
    writeJson(res, 404, {
      error: {
        code: 'not_found',
        message: `No compliance case with id '${caseId}'.`,
      },
    });
    return;
  }

  writeJson(res, 200, {
    case: existing,
  });
}

async function handleDecideComplianceCase(
  caseId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const payload = await readJsonBodyForRoute(req, res);
  if (payload === undefined) return;

  const parsed = CaseDecisionRequestSchema.safeParse(payload);
  if (!parsed.success) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: 'Invalid request payload for compliance case decision.',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const existing = complianceCasesById.get(caseId);
  if (!existing) {
    writeJson(res, 404, {
      error: {
        code: 'not_found',
        message: `No compliance case with id '${caseId}'.`,
      },
    });
    return;
  }

  const decisionInput = parsed.data;
  const proposedBy = decisionInput.proposedBy ?? decisionInput.decidedBy;
  if (decisionInput.approvedBy && decisionInput.approvedBy === proposedBy) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: 'Four-eyes rule violated: approvedBy must be different from proposedBy.',
      },
    });
    return;
  }

  const now = new Date().toISOString();
  const requiresFourEyes = decisionInput.decision !== 'false_positive';
  const approvalStatus = requiresFourEyes
    ? decisionInput.approvedBy
      ? 'approved'
      : 'pending'
    : 'not_required';

  const decision: StoredCaseDecision = {
    decisionId: randomUUID(),
    decision: decisionInput.decision,
    decidedBy: decisionInput.decidedBy,
    proposedBy,
    ...(decisionInput.approvedBy ? { approvedBy: decisionInput.approvedBy } : {}),
    ...(decisionInput.comment ? { comment: decisionInput.comment } : {}),
    requiresFourEyes,
    approvalStatus,
    decidedAt: now,
  };

  existing.decisions.unshift(decision);
  existing.updatedAt = now;
  existing.status =
    decisionInput.decision === 'false_positive'
      ? 'closed'
      : decisionInput.approvedBy
        ? 'closed'
        : 'pending_approval';

  const reviewStatus =
    decisionInput.decision === 'confirmed_match'
      ? 'confirmed_match'
      : decisionInput.decision === 'false_positive'
        ? 'false_positive'
        : 'escalated';

  for (const hit of existing.hits) {
    if (hit.reviewStatus === 'open') {
      hit.reviewStatus = reviewStatus;
    }
  }

  writeJson(res, 200, {
    caseId: existing.caseId,
    status: existing.status,
    decision,
    note: 'Decision recorded. A screening hit remains a candidate to verify; final action is subject to your compliance workflow.',
  });
}

async function handleCreateException(
  bpId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const payload = await readJsonBodyForRoute(req, res);
  if (payload === undefined) return;

  const parsed = CreateExceptionRequestSchema.safeParse(payload);
  if (!parsed.success) {
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: 'Invalid request payload for exception creation.',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const now = new Date().toISOString();
  const created: StoredException = {
    exceptionId: randomUUID(),
    sourceEntryId: parsed.data.sourceEntryId,
    justification: parsed.data.justification,
    ...(parsed.data.validFrom ? { validFrom: parsed.data.validFrom } : {}),
    ...(parsed.data.validUntil ? { validUntil: parsed.data.validUntil } : {}),
    status: 'active',
    createdAt: now,
  };

  const current = exceptionsByBpId.get(bpId) ?? [];
  current.push(created);
  exceptionsByBpId.set(bpId, current);

  writeJson(res, 201, {
    bpId,
    exceptionId: created.exceptionId,
    status: 'created',
    exception: created,
  });
}

async function executeScreening(
  input: BusinessPartnerScreenRequest,
  reqLog: ContextLogger,
): Promise<
  | {
      body: ScreeningResponseBody;
    }
  | {
      status: 503;
      error: {
        code: 'mirror_not_ready';
        message: string;
        recovery: string;
      };
    }
> {
  const svc = getScreeningService();
  const sanctions = await svc.sanctionsReadiness();
  if (!sanctions.ready) {
    return {
      status: 503,
      error: {
        code: 'mirror_not_ready',
        message: 'The local sanctions mirror is not yet populated.',
        recovery:
          'Run the mirror:init lifecycle script to load the sanctions lists, then retry; check /api/v1/sources for readiness.',
      },
    };
  }

  const sources = input.sources && input.sources.length > 0 ? input.sources : [...SOURCE_CODES];
  const result = await svc.screenName(
    {
      query: input.name,
      entityType: input.entityType,
      matchMode: input.matchMode,
      ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
      sources,
      limit: input.limit,
      offset: input.offset,
    },
    { log: reqLog },
  );

  const hasMore = input.offset + result.hits.length < result.totalAvailable;
  const notice =
    result.totalAvailable === 0
      ? `No potential match for "${input.name}" across the selected lists (mode: ${result.modeUsed}). This is NOT a clearance.`
      : result.hits.length === 0
        ? `Offset ${input.offset} is past the end of this result set (${result.totalAvailable} available).`
        : undefined;

  return {
    body: {
      businessPartner: {
        ...(input.bpId ? { bpId: input.bpId } : {}),
        name: input.name,
        ...(input.country ? { country: input.country } : {}),
        ...(input.role ? { role: input.role } : {}),
      },
      screening: {
        normalizedQuery: result.normalizedQuery,
        requestedMatchMode: input.matchMode,
        matchModeUsed: result.modeUsed,
        entityType: input.entityType,
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        sources,
        ...(sanctions.completedAt ? { sourcesAsOf: sanctions.completedAt } : {}),
      },
      pagination: {
        limit: input.limit,
        offset: input.offset,
        returned: result.hits.length,
        totalAvailable: result.totalAvailable,
        totalAvailableBasis: result.totalAvailableBasis,
        hasMore,
        ...(hasMore ? { nextOffset: input.offset + result.hits.length } : {}),
      },
      hits: result.hits.map((hit) => ({
        source: hit.source,
        sourceLabel: SOURCE_LABELS[hit.source],
        sourceEntryId: hit.sourceEntryId,
        entityType: hit.entityType,
        primaryName: hit.primaryName,
        matchedName: hit.matchedName,
        matchedNameType: hit.matchedNameType,
        matchType: hit.matchType,
        ...(hit.score !== undefined ? { score: hit.score } : {}),
        ...(hit.queryTokenCoverage ? { queryTokenCoverage: hit.queryTokenCoverage } : {}),
        ...(hit.program ? { program: hit.program } : {}),
        ...(hit.designationDate ? { designationDate: hit.designationDate } : {}),
      })),
      ...(notice ? { notice } : {}),
      caveat: SCREENING_CAVEAT,
    },
  };
}

function recordSuccessfulScreeningSideEffects(
  input: BusinessPartnerScreenRequest,
  responseBody: ScreeningResponseBody,
): void {
  if (!input.bpId) return;

  const eventId = randomUUID();
  appendHistoryEvent({
    eventId,
    bpId: input.bpId,
    queryName: input.name,
    matchMode: input.matchMode,
    matchModeUsed: responseBody.screening.matchModeUsed,
    entityType: input.entityType,
    sourcesQueried: responseBody.screening.sources,
    ...(responseBody.screening.sourcesAsOf
      ? { sourcesAsOf: responseBody.screening.sourcesAsOf }
      : {}),
    executedAt: new Date().toISOString(),
    hitCount: responseBody.hits.length,
    screeningStatus: 'screened',
  });

  upsertComplianceCaseFromScreening(input.bpId, input.name, eventId, responseBody.hits);
}

function appendHistoryEvent(event: StoredScreeningEvent): void {
  const current = historyByBpId.get(event.bpId) ?? [];
  current.unshift(event);
  historyByBpId.set(event.bpId, current);
}

function clearRestState(): void {
  historyByBpId.clear();
  exceptionsByBpId.clear();
  complianceCasesById.clear();
  complianceCaseIdsByBpId.clear();
}

function parsePositiveInt(raw: string | null, defaultValue: number, max: number): number {
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) return defaultValue;
  return Math.min(value, max);
}

async function readJsonBodyForRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | undefined> {
  try {
    return await readJsonBody(req);
  } catch (error) {
    const err = toError(error);
    writeJson(res, 400, {
      error: {
        code: 'validation_error',
        message: err.message,
      },
    });
    return undefined;
  }
}

function matchBpHistoryPath(pathname: string): { bpId: string } | undefined {
  const match = /^\/api\/v1\/screening\/business-partner\/([^/]+)\/history$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return { bpId: decodeURIComponent(match[1]) };
}

function matchDesignationPath(
  pathname: string,
): { source: SourceCode; entryId: string } | undefined {
  const match = /^\/api\/v1\/designations\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match?.[1] || !match?.[2]) return undefined;
  const sourceParsed = SOURCE_ENUM.safeParse(decodeURIComponent(match[1]));
  if (!sourceParsed.success) return undefined;
  const entryId = decodeURIComponent(match[2]).trim();
  if (!entryId) return undefined;
  return { source: sourceParsed.data, entryId };
}

function matchExceptionsPath(pathname: string): { bpId: string } | undefined {
  const match = /^\/api\/v1\/exceptions\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return { bpId: decodeURIComponent(match[1]) };
}

function matchComplianceCasePath(pathname: string): { caseId: string } | undefined {
  const match = /^\/api\/v1\/compliance\/cases\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return { caseId: decodeURIComponent(match[1]) };
}

function matchComplianceCaseDecisionPath(pathname: string): { caseId: string } | undefined {
  const match = /^\/api\/v1\/compliance\/cases\/([^/]+)\/decision$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return { caseId: decodeURIComponent(match[1]) };
}

function upsertComplianceCaseFromScreening(
  bpId: string,
  businessPartnerName: string,
  eventId: string,
  hits: Array<Record<string, unknown>>,
): void {
  const caseHits = normalizeCaseHits(hits);
  if (caseHits.length === 0) return;

  const caseIds = complianceCaseIdsByBpId.get(bpId) ?? [];
  const openCase = caseIds
    .map((id) => complianceCasesById.get(id))
    .find((item): item is StoredComplianceCase => !!item && item.status !== 'closed');

  if (openCase) {
    openCase.updatedAt = new Date().toISOString();
    openCase.latestEventId = eventId;
    openCase.eventIds.unshift(eventId);
    mergeCaseHits(openCase, caseHits);
    openCase.priority = inferCasePriority(openCase.hits);
    return;
  }

  const now = new Date().toISOString();
  const created: StoredComplianceCase = {
    caseId: randomUUID(),
    bpId,
    businessPartnerName,
    status: 'open',
    priority: inferCasePriority(caseHits),
    createdAt: now,
    updatedAt: now,
    latestEventId: eventId,
    eventIds: [eventId],
    hits: caseHits,
    decisions: [],
  };

  complianceCasesById.set(created.caseId, created);
  complianceCaseIdsByBpId.set(bpId, [created.caseId, ...caseIds]);
}

function normalizeCaseHits(hits: Array<Record<string, unknown>>): StoredCaseHit[] {
  const out: StoredCaseHit[] = [];
  for (const hit of hits) {
    const source = typeof hit.source === 'string' && hit.source.length > 0 ? hit.source : undefined;
    const sourceEntryId =
      typeof hit.sourceEntryId === 'string' && hit.sourceEntryId.length > 0
        ? hit.sourceEntryId
        : undefined;
    const matchedName =
      typeof hit.matchedName === 'string' && hit.matchedName.length > 0
        ? hit.matchedName
        : undefined;
    const matchType =
      hit.matchType === 'exact' || hit.matchType === 'strong' || hit.matchType === 'approximate'
        ? hit.matchType
        : undefined;
    if (!source || !sourceEntryId || !matchedName || !matchType) continue;

    out.push({
      hitId: randomUUID(),
      source,
      sourceEntryId,
      matchedName,
      matchType,
      ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
      reviewStatus: 'open',
    });
  }
  return out;
}

function mergeCaseHits(complianceCase: StoredComplianceCase, newHits: StoredCaseHit[]): void {
  const existingKeys = new Set(
    complianceCase.hits.map((hit) => `${hit.source}|${hit.sourceEntryId}|${hit.matchedName}`),
  );

  for (const hit of newHits) {
    const key = `${hit.source}|${hit.sourceEntryId}|${hit.matchedName}`;
    if (existingKeys.has(key)) continue;
    complianceCase.hits.push(hit);
    existingKeys.add(key);
  }
}

function inferCasePriority(hits: StoredCaseHit[]): 'low' | 'medium' | 'high' {
  if (hits.some((hit) => hit.matchType === 'exact')) return 'high';
  if (hits.some((hit) => hit.matchType === 'strong')) return 'medium';
  return 'low';
}

function createRequestLogger(operation: string, requestId: string): ContextLogger {
  const contextFor = (data?: Record<string, unknown>) =>
    requestContextService.createRequestContext({
      operation,
      parentContext: { requestId },
      ...(data ? { additionalContext: data } : {}),
    });

  return {
    debug(msg, data) {
      logger.debug(msg, contextFor(data));
    },
    info(msg, data) {
      logger.info(msg, contextFor(data));
    },
    notice(msg, data) {
      logger.notice(msg, contextFor(data));
    },
    warning(msg, data) {
      logger.warning(msg, contextFor(data));
    },
    error(msg, error, data) {
      if (error) {
        logger.error(msg, error, contextFor(data));
        return;
      }
      logger.error(msg, contextFor(data));
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  const maxBytes = 1_000_000;

  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    byteCount += buffer.length;
    if (byteCount > maxBytes) {
      throw new Error(`Request payload exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Request payload is not valid JSON.');
  }
}

function readRequestId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header.length > 0 && header[0]?.trim()) return header[0].trim();
  return randomUUID();
}

function writeNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    `Content-Type, X-Request-Id, ${IDEMPOTENCY_KEY_HEADER}`,
  );
  res.end();
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    `Content-Type, X-Request-Id, ${IDEMPOTENCY_KEY_HEADER}`,
  );
  res.setHeader('X-Rest-Timeout-Ms', String(DEFAULT_REST_TIMEOUT_MS));
  res.end(JSON.stringify(payload));
}

function writeHtml(res: ServerResponse, status: number, payload: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    `Content-Type, X-Request-Id, ${IDEMPOTENCY_KEY_HEADER}`,
  );
  res.setHeader('X-Rest-Timeout-Ms', String(DEFAULT_REST_TIMEOUT_MS));
  res.end(payload);
}

function writeText(
  res: ServerResponse,
  status: number,
  payload: string,
  contentType: string,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    `Content-Type, X-Request-Id, ${IDEMPOTENCY_KEY_HEADER}`,
  );
  res.setHeader('X-Rest-Timeout-Ms', String(DEFAULT_REST_TIMEOUT_MS));
  res.end(payload);
}

function renderSwaggerUiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>REST Facade API Docs</title>
    <link rel="stylesheet" href="/ui/swagger-ui.css" />
    <style>
      html,
      body {
        margin: 0;
        background: #f6f8fb;
      }

      .topbar {
        padding: 0.75rem 1rem;
        background: linear-gradient(90deg, #0a4b87, #0a6ed1);
        color: #fff;
        font: 600 14px/1.2 "72", "Segoe UI", Tahoma, sans-serif;
      }

      #swagger-ui {
        max-width: 1280px;
        margin: 0 auto;
      }
    </style>
  </head>
  <body>
    <div class="topbar">sanctions-screening-mcp-server REST facade - Swagger UI</div>
    <div id="swagger-ui"></div>

    <script src="/ui/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/api/v1/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        displayRequestDuration: true,
      });
    </script>
  </body>
</html>`;
}

function renderComplianceCasesUiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Compliance Cases</title>
    <style>
      :root {
        --bg: #f3f6f8;
        --panel: #ffffff;
        --ink: #0f2a3d;
        --ink-soft: #4b6070;
        --accent: #0a6ed1;
        --accent-strong: #0854a0;
        --warn: #e9730c;
        --ok: #107e3e;
        --risk: #bb0000;
        --line: #d8e0e8;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "72", "Segoe UI", Tahoma, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at 20% 10%, #dceeff 0%, transparent 36%),
          radial-gradient(circle at 85% 0%, #e5f4ec 0%, transparent 32%),
          var(--bg);
      }

      header {
        padding: 1.1rem 1.4rem;
        background: linear-gradient(120deg, #0a4b87, #0a6ed1);
        color: #fff;
      }

      header h1 {
        margin: 0;
        font-size: 1.15rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }

      main {
        display: grid;
        grid-template-columns: minmax(18rem, 29rem) 1fr;
        gap: 1rem;
        padding: 1rem;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 0.6rem;
        box-shadow: 0 0.35rem 1.1rem rgba(5, 34, 60, 0.08);
      }

      .list-panel {
        overflow: hidden;
      }

      .toolbar {
        display: flex;
        gap: 0.55rem;
        align-items: center;
        padding: 0.8rem;
        border-bottom: 1px solid var(--line);
        background: #f9fbfc;
      }

      select,
      button,
      textarea,
      input {
        font: inherit;
      }

      select,
      input,
      textarea {
        border: 1px solid #b8c7d6;
        border-radius: 0.35rem;
        padding: 0.45rem 0.55rem;
      }

      button {
        border: 0;
        border-radius: 0.35rem;
        padding: 0.45rem 0.7rem;
        background: var(--accent);
        color: #fff;
        cursor: pointer;
      }

      button.secondary {
        background: #647a8f;
      }

      button.warn {
        background: var(--warn);
      }

      button.risk {
        background: var(--risk);
      }

      #caseList {
        max-height: calc(100vh - 13rem);
        overflow: auto;
      }

      .case-row {
        padding: 0.7rem 0.8rem;
        border-bottom: 1px solid var(--line);
        cursor: pointer;
      }

      .case-row:hover {
        background: #f5f9ff;
      }

      .case-row.active {
        background: #e9f3fe;
        border-left: 0.3rem solid var(--accent);
      }

      .meta {
        font-size: 0.85rem;
        color: var(--ink-soft);
      }

      .badge {
        display: inline-block;
        margin-right: 0.35rem;
        padding: 0.12rem 0.45rem;
        border-radius: 0.8rem;
        font-size: 0.74rem;
        color: #fff;
        background: #647a8f;
      }

      .badge.open,
      .badge.in_review {
        background: var(--warn);
      }

      .badge.pending_approval {
        background: #8e44ad;
      }

      .badge.closed {
        background: var(--ok);
      }

      .detail-panel {
        padding: 1rem;
        display: grid;
        gap: 0.85rem;
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
        gap: 0.6rem;
      }

      .box {
        border: 1px solid var(--line);
        border-radius: 0.45rem;
        padding: 0.55rem;
        background: #fcfdff;
      }

      .hits,
      .decisions {
        border-collapse: collapse;
        width: 100%;
      }

      .hits th,
      .hits td,
      .decisions th,
      .decisions td {
        border-bottom: 1px solid var(--line);
        text-align: left;
        padding: 0.42rem;
        font-size: 0.88rem;
      }

      .form {
        display: grid;
        gap: 0.5rem;
      }

      .hint {
        font-size: 0.8rem;
        color: var(--ink-soft);
      }

      @media (max-width: 1024px) {
        main {
          grid-template-columns: 1fr;
        }

        #caseList {
          max-height: 22rem;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Compliance Case Worklist</h1>
    </header>
    <main>
      <section class="panel list-panel">
        <div class="toolbar">
          <label for="statusFilter">Status</label>
          <select id="statusFilter">
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="in_review">In Review</option>
            <option value="pending_approval">Pending Approval</option>
            <option value="closed">Closed</option>
          </select>
          <button id="refreshBtn" class="secondary">Refresh</button>
        </div>
        <div id="caseList"></div>
      </section>
      <section class="panel detail-panel">
        <div id="detailEmpty" class="hint">Select a case from the worklist.</div>
        <div id="detailRoot" hidden>
          <h2 id="detailTitle" style="margin-top:0"></h2>
          <div id="detailMeta" class="detail-grid"></div>

          <h3 style="margin-bottom:0.3rem">Hits</h3>
          <table class="hits">
            <thead>
              <tr><th>Source</th><th>Entry</th><th>Matched Name</th><th>Type</th><th>Status</th></tr>
            </thead>
            <tbody id="hitsBody"></tbody>
          </table>

          <h3 style="margin-bottom:0.3rem">Decisions</h3>
          <table class="decisions">
            <thead>
              <tr><th>At</th><th>Decision</th><th>By</th><th>Approval</th><th>Comment</th></tr>
            </thead>
            <tbody id="decisionsBody"></tbody>
          </table>

          <h3 style="margin-bottom:0.3rem">Record Decision</h3>
          <div class="form">
            <select id="decisionType">
              <option value="false_positive">False Positive</option>
              <option value="confirmed_match">Confirmed Match</option>
              <option value="escalate">Escalate</option>
            </select>
            <input id="decidedBy" placeholder="decidedBy (required)" />
            <input id="approvedBy" placeholder="approvedBy (optional, must differ for 4-eyes)" />
            <textarea id="decisionComment" rows="3" placeholder="comment (optional)"></textarea>
            <div style="display:flex; gap:0.5rem; align-items:center">
              <button id="submitDecision">Submit Decision</button>
              <span class="hint" id="decisionResult"></span>
            </div>
          </div>
        </div>
      </section>
    </main>

    <script>
      const state = { cases: [], selectedCaseId: null };

      async function loadCases() {
        const status = document.getElementById('statusFilter').value;
        const query = status ? '?status=' + encodeURIComponent(status) : '';
        const response = await fetch('/api/v1/compliance/cases' + query);
        const payload = await response.json();
        state.cases = payload.cases || [];
        renderList();
        if (state.selectedCaseId) {
          await loadCase(state.selectedCaseId);
        }
      }

      function renderList() {
        const root = document.getElementById('caseList');
        if (!state.cases.length) {
          root.innerHTML = '<div class="case-row"><div class="meta">No cases available yet. Run screening with hits to create cases.</div></div>';
          return;
        }

        root.innerHTML = state.cases.map((c) => {
          const active = c.caseId === state.selectedCaseId ? 'active' : '';
          return '<div class="case-row ' + active + '" data-case-id="' + c.caseId + '">' +
            '<div><span class="badge ' + c.status + '">' + c.status + '</span><strong>' + escapeHtml(c.businessPartnerName) + '</strong></div>' +
            '<div class="meta">BP: ' + escapeHtml(c.bpId) + ' | Priority: ' + c.priority + ' | Hits: ' + c.hitCount + '</div>' +
          '</div>';
        }).join('');

        root.querySelectorAll('.case-row[data-case-id]').forEach((el) => {
          el.addEventListener('click', async () => {
            state.selectedCaseId = el.getAttribute('data-case-id');
            renderList();
            await loadCase(state.selectedCaseId);
          });
        });
      }

      async function loadCase(caseId) {
        const response = await fetch('/api/v1/compliance/cases/' + encodeURIComponent(caseId));
        if (!response.ok) return;
        const payload = await response.json();
        renderDetail(payload.case);
      }

      function renderDetail(c) {
        document.getElementById('detailEmpty').hidden = true;
        document.getElementById('detailRoot').hidden = false;
        document.getElementById('detailTitle').textContent = c.businessPartnerName + ' (' + c.bpId + ')';

        const meta = document.getElementById('detailMeta');
        meta.innerHTML = [
          box('Case ID', c.caseId),
          box('Status', c.status),
          box('Priority', c.priority),
          box('Latest Event', c.latestEventId),
          box('Created', c.createdAt),
          box('Updated', c.updatedAt),
        ].join('');

        document.getElementById('hitsBody').innerHTML = (c.hits || []).map((h) =>
          '<tr>' +
            '<td>' + escapeHtml(h.source) + '</td>' +
            '<td>' + escapeHtml(h.sourceEntryId) + '</td>' +
            '<td>' + escapeHtml(h.matchedName) + '</td>' +
            '<td>' + escapeHtml(h.matchType) + (h.score !== undefined ? ' (' + h.score.toFixed(3) + ')' : '') + '</td>' +
            '<td>' + escapeHtml(h.reviewStatus) + '</td>' +
          '</tr>'
        ).join('');

        document.getElementById('decisionsBody').innerHTML = (c.decisions || []).map((d) =>
          '<tr>' +
            '<td>' + escapeHtml(d.decidedAt) + '</td>' +
            '<td>' + escapeHtml(d.decision) + '</td>' +
            '<td>' + escapeHtml(d.decidedBy) + '</td>' +
            '<td>' + escapeHtml(d.approvalStatus) + '</td>' +
            '<td>' + escapeHtml(d.comment || '') + '</td>' +
          '</tr>'
        ).join('');
      }

      function box(label, value) {
        return '<div class="box"><div class="meta">' + escapeHtml(label) + '</div><div>' + escapeHtml(String(value || '')) + '</div></div>';
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      async function submitDecision() {
        if (!state.selectedCaseId) return;
        const decision = document.getElementById('decisionType').value;
        const decidedBy = document.getElementById('decidedBy').value.trim();
        const approvedBy = document.getElementById('approvedBy').value.trim();
        const comment = document.getElementById('decisionComment').value.trim();
        if (!decidedBy) {
          document.getElementById('decisionResult').textContent = 'decidedBy is required.';
          return;
        }

        const body = {
          decision,
          decidedBy,
          ...(approvedBy ? { approvedBy } : {}),
          ...(comment ? { comment } : {}),
        };

        const response = await fetch('/api/v1/compliance/cases/' + encodeURIComponent(state.selectedCaseId) + '/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const payload = await response.json();
        if (!response.ok) {
          document.getElementById('decisionResult').textContent = payload?.error?.message || 'Decision failed.';
          return;
        }

        document.getElementById('decisionResult').textContent = 'Decision saved.';
        await loadCases();
      }

      document.getElementById('refreshBtn').addEventListener('click', loadCases);
      document.getElementById('statusFilter').addEventListener('change', loadCases);
      document.getElementById('submitDecision').addEventListener('click', submitDecision);

      loadCases().catch(() => {
        document.getElementById('caseList').innerHTML = '<div class="case-row"><div class="meta">Unable to load cases.</div></div>';
      });
    </script>
  </body>
</html>`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
