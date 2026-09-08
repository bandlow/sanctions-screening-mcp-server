/**
 * @fileoverview REST facade integration coverage for compliance-case endpoints
 * and the lightweight worklist UI route.
 * @module tests/rest/rest-facade.test
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ComplianceCaseSummary {
  caseId: string;
  bpId: string;
  status: "open" | "in_review" | "pending_approval" | "closed";
  hitCount: number;
}

interface ComplianceCaseDecisionResponse {
  caseId: string;
  status: "open" | "in_review" | "pending_approval" | "closed";
  decision: {
    decision: "confirmed_match" | "false_positive" | "escalate";
    decidedBy: string;
    proposedBy: string;
    approvedBy?: string;
    approvalStatus: "not_required" | "pending" | "approved";
  };
}

const httpPort = 38010;
const restBaseUrl = `http://127.0.0.1:${httpPort + 1}`;

let stopRestFacade: (() => Promise<void>) | undefined;
let tempDir = "";
let closeScreeningService: (() => Promise<void>) | undefined;
let resetScreeningServiceFn: (() => void) | undefined;
let resetServerConfigFn: (() => void) | undefined;

beforeAll(async () => {
  process.env.MCP_TRANSPORT_TYPE = "http";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.MCP_HTTP_PORT = String(httpPort);
  tempDir = mkdtempSync(join(tmpdir(), "sanctions-rest-test-"));
  process.env.SANCTIONS_MIRROR_PATH = join(tempDir, "test.db");

  vi.resetModules();

  const { resetServerConfig } = await import("@/config/server-config.js");
  const { getScreeningService, initScreeningService, resetScreeningService } =
    await import("@/services/screening/screening-service.js");
  const {
    FIXTURE_DESIGNATIONS,
    FIXTURE_LEI_ENTITIES,
    FIXTURE_LEI_RELATIONSHIPS,
  } = await import("@/services/screening/fixtures.js");

  resetServerConfig();
  resetScreeningService();
  initScreeningService();
  const service = getScreeningService();
  await service.seedFixtures({
    designations: FIXTURE_DESIGNATIONS,
    leiEntities: FIXTURE_LEI_ENTITIES,
    leiRelationships: FIXTURE_LEI_RELATIONSHIPS,
  });

  closeScreeningService = () => service.close();
  resetScreeningServiceFn = resetScreeningService;
  resetServerConfigFn = resetServerConfig;

  const rest = await import("@/rest/rest-facade.js");
  stopRestFacade = rest.stopRestFacade;
  await rest.startRestFacade();
}, 30_000);

afterAll(async () => {
  await stopRestFacade?.();
  await closeScreeningService?.();
  resetScreeningServiceFn?.();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows can transiently hold SQLite files; cleanup failures are non-fatal.
  }

  delete process.env.MCP_TRANSPORT_TYPE;
  delete process.env.MCP_HTTP_HOST;
  delete process.env.MCP_HTTP_PORT;
  delete process.env.SANCTIONS_MIRROR_PATH;
  resetServerConfigFn?.();

  vi.resetModules();
});

describe("REST facade compliance-case endpoints", () => {
  it("serves the compliance worklist UI route", async () => {
    const response = await fetch(`${restBaseUrl}/ui/compliance-cases`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Compliance Case Worklist");
  });

  it("creates a case from screening hits and exposes it via list/detail APIs", async () => {
    const screeningResponse = await fetch(
      `${restBaseUrl}/api/v1/screening/business-partner`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bpId: "BP-CASE-1001",
          name: "Ivan Testovich Volkov",
          role: "vendor",
          country: "DE",
          matchMode: "strict",
        }),
      },
    );

    const screeningPayload = (await screeningResponse.json()) as {
      caveat: string;
      hits: unknown[];
    };

    expect(screeningResponse.status).toBe(200);
    expect(screeningPayload.hits.length).toBeGreaterThan(0);
    expect(screeningPayload.caveat).toContain("not a compliance determination");

    const listResponse = await fetch(
      `${restBaseUrl}/api/v1/compliance/cases?status=open`,
    );
    const listPayload = (await listResponse.json()) as {
      cases: ComplianceCaseSummary[];
    };

    expect(listResponse.status).toBe(200);
    const createdCase = listPayload.cases.find(
      (item) => item.bpId === "BP-CASE-1001",
    );
    expect(createdCase).toBeDefined();
    expect(createdCase?.status).toBe("open");
    expect((createdCase?.hitCount ?? 0) > 0).toBe(true);

    const detailResponse = await fetch(
      `${restBaseUrl}/api/v1/compliance/cases/${createdCase?.caseId}`,
    );
    const detailPayload = (await detailResponse.json()) as {
      case: {
        caseId: string;
        bpId: string;
        status: string;
        hits: Array<{ reviewStatus: string }>;
      };
    };

    expect(detailResponse.status).toBe(200);
    expect(detailPayload.case.bpId).toBe("BP-CASE-1001");
    expect(detailPayload.case.hits.length).toBeGreaterThan(0);
    expect(detailPayload.case.hits[0]?.reviewStatus).toBe("open");
  });

  it("enforces the four-eyes guardrail and accepts approved decisions", async () => {
    await fetch(`${restBaseUrl}/api/v1/screening/business-partner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bpId: "BP-CASE-1002",
        name: "Ivan Testovich Volkov",
        matchMode: "strict",
      }),
    });

    const listResponse = await fetch(
      `${restBaseUrl}/api/v1/compliance/cases?status=open`,
    );
    const listPayload = (await listResponse.json()) as {
      cases: ComplianceCaseSummary[];
    };
    const targetCase = listPayload.cases.find(
      (item) => item.bpId === "BP-CASE-1002",
    );
    expect(targetCase).toBeDefined();

    const invalidDecisionResponse = await fetch(
      `${restBaseUrl}/api/v1/compliance/cases/${targetCase?.caseId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "confirmed_match",
          decidedBy: "alice",
          proposedBy: "alice",
          approvedBy: "alice",
        }),
      },
    );

    const invalidDecisionPayload = (await invalidDecisionResponse.json()) as {
      error: { code: string; message: string };
    };

    expect(invalidDecisionResponse.status).toBe(400);
    expect(invalidDecisionPayload.error.code).toBe("validation_error");
    expect(invalidDecisionPayload.error.message).toContain("Four-eyes rule");

    const validDecisionResponse = await fetch(
      `${restBaseUrl}/api/v1/compliance/cases/${targetCase?.caseId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "confirmed_match",
          decidedBy: "alice",
          proposedBy: "alice",
          approvedBy: "bob",
          comment: "Potential true positive confirmed for review workflow.",
        }),
      },
    );

    const validDecisionPayload =
      (await validDecisionResponse.json()) as ComplianceCaseDecisionResponse;

    expect(validDecisionResponse.status).toBe(200);
    expect(validDecisionPayload.status).toBe("closed");
    expect(validDecisionPayload.decision.decision).toBe("confirmed_match");
    expect(validDecisionPayload.decision.approvalStatus).toBe("approved");

    const detailResponse = await fetch(
      `${restBaseUrl}/api/v1/compliance/cases/${targetCase?.caseId}`,
    );
    const detailPayload = (await detailResponse.json()) as {
      case: {
        status: "open" | "in_review" | "pending_approval" | "closed";
        hits: Array<{ reviewStatus: string }>;
      };
    };

    expect(detailResponse.status).toBe(200);
    expect(detailPayload.case.status).toBe("closed");
    expect(
      detailPayload.case.hits.every(
        (hit) => hit.reviewStatus === "confirmed_match",
      ),
    ).toBe(true);
  });

  it("returns validation_error for unknown case-status filters", async () => {
    const response = await fetch(
      `${restBaseUrl}/api/v1/compliance/cases?status=unknown-status`,
    );
    const payload = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("validation_error");
    expect(payload.error.message).toContain("status");
  });
});
