/**
 * @fileoverview REST facade for classical SAP/CAP backend integration. Exposes
 * stable HTTP endpoints over the existing screening engine (no duplicate
 * business logic): name screening for business partners and source freshness.
 *
 * The facade starts only on HTTP transport and listens on `MCP_HTTP_PORT + 1`
 * to avoid colliding with the MCP endpoint.
 * @module rest/rest-facade
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { z, type ContextLogger } from "@cyanheads/mcp-ts-core";
import { config } from "@cyanheads/mcp-ts-core/config";
import { logger, requestContextService } from "@cyanheads/mcp-ts-core/utils";
import {
  GLEIF_LICENSE,
  GLEIF_SOURCE_LABEL,
  SCREENING_CAVEAT,
  SOURCE_LICENSES,
  gleifSourceUrl,
  sourceUrls,
} from "@/mcp-server/tools/definitions/_shared.js";
import { getScreeningService } from "@/services/screening/screening-service.js";
import {
  SOURCE_CODES,
  SOURCE_LABELS,
  type SourceCode,
} from "@/services/screening/types.js";

const SOURCE_ENUM = z.enum(["ofac_sdn", "ofac_consolidated", "eu", "uk", "un"]);

const BusinessPartnerScreenRequestSchema = z
  .object({
    bpId: z
      .string()
      .min(1)
      .optional()
      .describe("Optional external business partner identifier from SAP."),
    name: z.string().min(1).describe("Business partner name to screen."),
    country: z
      .string()
      .length(2)
      .optional()
      .describe(
        "Optional ISO 3166-1 alpha-2 country code from the source system.",
      ),
    role: z
      .enum(["customer", "vendor", "other"])
      .optional()
      .describe("Optional business role from the source system."),
    entityType: z
      .enum(["any", "person", "organization", "vessel", "aircraft"])
      .default("any")
      .describe("Entity-type restriction forwarded to the screening engine."),
    matchMode: z
      .enum(["strict", "fuzzy"])
      .default("strict")
      .describe("Matching mode: strict first, fuzzy optional/fallback."),
    minScore: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Optional fuzzy similarity floor (0-1)."),
    sources: z
      .array(SOURCE_ENUM)
      .optional()
      .describe(
        "Optional source-list subset. Omit to screen across all lists.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Maximum hits to return."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Zero-based pagination offset."),
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
            role: z.enum(["customer", "vendor", "other"]).optional(),
          })
          .strict(),
      )
      .min(1),
    screening: z
      .object({
        entityType: z
          .enum(["any", "person", "organization", "vessel", "aircraft"])
          .default("any"),
        matchMode: z.enum(["strict", "fuzzy"]).default("strict"),
        minScore: z.number().min(0).max(1).optional(),
        sources: z.array(SOURCE_ENUM).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      })
      .optional(),
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

type BusinessPartnerScreenRequest = z.infer<
  typeof BusinessPartnerScreenRequestSchema
>;

type StoredScreeningEvent = {
  eventId: string;
  bpId: string;
  queryName: string;
  matchMode: "strict" | "fuzzy";
  matchModeUsed: "strict" | "fuzzy";
  entityType: "any" | "person" | "organization" | "vessel" | "aircraft";
  sourcesQueried: string[];
  sourcesAsOf?: string;
  executedAt: string;
  hitCount: number;
  screeningStatus: "screened" | "not_ready" | "error";
};

type StoredException = {
  exceptionId: string;
  sourceEntryId: string;
  justification: string;
  validFrom?: string;
  validUntil?: string;
  status: "active";
  createdAt: string;
};

let restServer: Server | undefined;
const DEFAULT_REST_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const historyByBpId = new Map<string, StoredScreeningEvent[]>();
const exceptionsByBpId = new Map<string, StoredException[]>();

/** Start the REST facade when running on HTTP transport. Idempotent per process. */
export async function startRestFacade(): Promise<void> {
  if (config.mcpTransportType !== "http") return;
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
    server.once("error", reject);
    server.listen(restPort, config.mcpHttpHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  restServer = server;
  logger.info(
    `REST facade listening on http://${config.mcpHttpHost}:${restPort}/api/v1 (MCP remains on ${config.mcpHttpEndpointPath}).`,
    requestContextService.createRequestContext({
      operation: "rest.facade.start",
    }),
  );
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = readRequestId(req);
  const reqLog = createRequestLogger("rest.facade.request", requestId);

  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "OPTIONS") {
      writeNoContent(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/sources") {
      await handleListSources(res);
      return;
    }

    const historyMatch = matchBpHistoryPath(url.pathname);
    if (req.method === "GET" && historyMatch) {
      handleBusinessPartnerHistory(historyMatch.bpId, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/screening/batch") {
      await handleScreeningBatch(req, res, reqLog);
      return;
    }

    const exceptionMatch = matchExceptionsPath(url.pathname);
    if (req.method === "GET" && exceptionMatch) {
      handleListExceptions(exceptionMatch.bpId, res);
      return;
    }

    if (req.method === "POST" && exceptionMatch) {
      await handleCreateException(exceptionMatch.bpId, req, res);
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/v1/screening/business-partner"
    ) {
      await handleBusinessPartnerScreen(req, res, reqLog);
      return;
    }

    writeJson(res, 404, {
      error: {
        code: "not_found",
        message: `No REST route for ${req.method ?? "UNKNOWN"} ${url.pathname}.`,
      },
    });
  } catch (error) {
    reqLog.error("REST facade request failed", toError(error));
    writeJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Unexpected REST facade error.",
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
    code: "gleif",
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
        code: "validation_error",
        message: "Invalid request payload for business-partner screening.",
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const input = parsed.data;
  const response = await executeScreening(input, reqLog);
  if ("error" in response) {
    writeJson(res, response.status, {
      error: response.error,
    });
    return;
  }

  if (input.bpId) {
    appendHistoryEvent({
      eventId: randomUUID(),
      bpId: input.bpId,
      queryName: input.name,
      matchMode: input.matchMode,
      matchModeUsed: response.body.screening.matchModeUsed,
      entityType: input.entityType,
      sourcesQueried: response.body.screening.sources,
      ...(response.body.screening.sourcesAsOf
        ? { sourcesAsOf: response.body.screening.sourcesAsOf }
        : {}),
      executedAt: new Date().toISOString(),
      hitCount: response.body.hits.length,
      screeningStatus: "screened",
    });
  }

  writeJson(res, 200, response.body);
}

function handleBusinessPartnerHistory(
  bpId: string,
  url: URL,
  res: ServerResponse,
): void {
  const limit = parsePositiveInt(url.searchParams.get("limit"), 25, 100);
  const offset = parsePositiveInt(url.searchParams.get("offset"), 0, 1_000_000);

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
      ...(offset + page.length < events.length
        ? { nextOffset: offset + page.length }
        : {}),
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
        code: "validation_error",
        message: "Invalid request payload for screening batch.",
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
        entityType: input.screening?.entityType ?? "any",
        matchMode: input.screening?.matchMode ?? "strict",
        ...(input.screening?.minScore !== undefined
          ? { minScore: input.screening.minScore }
          : {}),
        ...(input.screening?.sources
          ? { sources: input.screening.sources }
          : {}),
        limit: input.screening?.limit ?? 25,
        offset: 0,
      },
      reqLog,
    );

    if ("error" in response) {
      failedCount += 1;
      if (item.bpId) {
        appendHistoryEvent({
          eventId: randomUUID(),
          bpId: item.bpId,
          queryName: item.name,
          matchMode: input.screening?.matchMode ?? "strict",
          matchModeUsed: input.screening?.matchMode ?? "strict",
          entityType: input.screening?.entityType ?? "any",
          sourcesQueried:
            input.screening?.sources && input.screening.sources.length > 0
              ? input.screening.sources
              : [...SOURCE_CODES],
          executedAt: new Date().toISOString(),
          hitCount: 0,
          screeningStatus:
            response.error.code === "mirror_not_ready" ? "not_ready" : "error",
        });
      }
      continue;
    }

    processedCount += 1;
    if (item.bpId) {
      appendHistoryEvent({
        eventId: randomUUID(),
        bpId: item.bpId,
        queryName: item.name,
        matchMode: input.screening?.matchMode ?? "strict",
        matchModeUsed: response.body.screening.matchModeUsed,
        entityType: input.screening?.entityType ?? "any",
        sourcesQueried: response.body.screening.sources,
        ...(response.body.screening.sourcesAsOf
          ? { sourcesAsOf: response.body.screening.sourcesAsOf }
          : {}),
        executedAt: new Date().toISOString(),
        hitCount: response.body.hits.length,
        screeningStatus: "screened",
      });
    }
  }

  writeJson(res, 202, {
    batchId,
    status: "accepted",
    acceptedAt,
    acceptedCount: input.items.length,
    processedCount,
    failedCount,
    note: "Batch endpoint currently processes immediately in-process and records per-BP history events.",
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
        code: "validation_error",
        message: "Invalid request payload for exception creation.",
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
    status: "active",
    createdAt: now,
  };

  const current = exceptionsByBpId.get(bpId) ?? [];
  current.push(created);
  exceptionsByBpId.set(bpId, current);

  writeJson(res, 201, {
    bpId,
    exceptionId: created.exceptionId,
    status: "created",
    exception: created,
  });
}

async function executeScreening(
  input: BusinessPartnerScreenRequest,
  reqLog: ContextLogger,
): Promise<
  | {
      body: {
        businessPartner: {
          bpId?: string;
          name: string;
          country?: string;
          role?: "customer" | "vendor" | "other";
        };
        screening: {
          normalizedQuery: string;
          requestedMatchMode: "strict" | "fuzzy";
          matchModeUsed: "strict" | "fuzzy";
          entityType: "any" | "person" | "organization" | "vessel" | "aircraft";
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
    }
  | {
      status: 503;
      error: {
        code: "mirror_not_ready";
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
        code: "mirror_not_ready",
        message: "The local sanctions mirror is not yet populated.",
        recovery:
          "Run the mirror:init lifecycle script to load the sanctions lists, then retry; check /api/v1/sources for readiness.",
      },
    };
  }

  const sources =
    input.sources && input.sources.length > 0
      ? input.sources
      : [...SOURCE_CODES];
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
        ...(sanctions.completedAt
          ? { sourcesAsOf: sanctions.completedAt }
          : {}),
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
        ...(hit.queryTokenCoverage
          ? { queryTokenCoverage: hit.queryTokenCoverage }
          : {}),
        ...(hit.program ? { program: hit.program } : {}),
        ...(hit.designationDate
          ? { designationDate: hit.designationDate }
          : {}),
      })),
      ...(notice ? { notice } : {}),
      caveat: SCREENING_CAVEAT,
    },
  };
}

function appendHistoryEvent(event: StoredScreeningEvent): void {
  const current = historyByBpId.get(event.bpId) ?? [];
  current.unshift(event);
  historyByBpId.set(event.bpId, current);
}

function parsePositiveInt(
  raw: string | null,
  defaultValue: number,
  max: number,
): number {
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
        code: "validation_error",
        message: err.message,
      },
    });
    return undefined;
  }
}

function matchBpHistoryPath(pathname: string): { bpId: string } | undefined {
  const match =
    /^\/api\/v1\/screening\/business-partner\/([^/]+)\/history$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return { bpId: decodeURIComponent(match[1]) };
}

function matchExceptionsPath(pathname: string): { bpId: string } | undefined {
  const match = /^\/api\/v1\/exceptions\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return { bpId: decodeURIComponent(match[1]) };
}

function createRequestLogger(
  operation: string,
  requestId: string,
): ContextLogger {
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
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    byteCount += buffer.length;
    if (byteCount > maxBytes) {
      throw new Error(`Request payload exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request payload is not valid JSON.");
  }
}

function readRequestId(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  if (typeof header === "string" && header.trim()) return header.trim();
  if (Array.isArray(header) && header.length > 0 && header[0]?.trim())
    return header[0].trim();
  return randomUUID();
}

function writeNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, X-Request-Id, ${IDEMPOTENCY_KEY_HEADER}`,
  );
  res.end();
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, X-Request-Id, ${IDEMPOTENCY_KEY_HEADER}`,
  );
  res.setHeader("X-Rest-Timeout-Ms", String(DEFAULT_REST_TIMEOUT_MS));
  res.end(JSON.stringify(payload));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
