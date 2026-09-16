/**
 * @fileoverview Direct MCP HTTP integration coverage for the screening server.
 * Boots the MCP surface itself against a seeded temp mirror and exercises the
 * JSON-RPC initialize, tools/list, tools/call, and resources/read flow without
 * using the auxiliary REST facade.
 * @module tests/integration/mcp-http-server.test
 */

import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@cyanheads/mcp-ts-core";
import type { ServerHandle } from "@cyanheads/mcp-ts-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetServerConfig } from "@/config/server-config.js";
import { allPromptDefinitions } from "@/mcp-server/prompts/definitions/index.js";
import { allResourceDefinitions } from "@/mcp-server/resources/definitions/index.js";
import { allToolDefinitions } from "@/mcp-server/tools/definitions/index.js";
import {
  FIXTURE_DESIGNATIONS,
  FIXTURE_LEI_ENTITIES,
  FIXTURE_LEI_RELATIONSHIPS,
} from "@/services/screening/fixtures.js";
import {
  getScreeningService,
  initScreeningService,
  resetScreeningService,
} from "@/services/screening/screening-service.js";

interface JsonRpcSuccess<T> {
  id?: number | string | null;
  jsonrpc: "2.0";
  result: T;
}

interface InitializeResult {
  protocolVersion: string;
  serverInfo?: {
    name?: string;
  };
}

interface ToolsListResult {
  tools: Array<{
    name: string;
  }>;
}

interface ToolCallResult {
  structuredContent?: {
    caveat?: string;
    hits?: Array<{
      primaryName?: string;
      source?: string;
    }>;
  };
  content?: Array<{
    type: string;
    text?: string;
  }>;
}

interface ResourceReadResult {
  contents?: Array<{
    mimeType?: string;
    text?: string;
    uri?: string;
  }>;
}

let serverHandle: ServerHandle | undefined;
let tempDir = "";
let mcpBaseUrl = "";

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  } catch {
    // Windows can briefly hold SQLite handles after shutdown; cleanup is best-effort.
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Could not acquire a free TCP port.")),
        );
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function postJson<T>(
  payload: Record<string, unknown>,
  sessionId?: string,
): Promise<{ body: T; response: Response }> {
  const response = await fetch(mcpBaseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return {
    response,
    body: text.length > 0 ? (JSON.parse(text) as T) : ({} as T),
  };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "sanctions-mcp-http-test-"));
  const port = await getFreePort();

  process.env.MCP_TRANSPORT_TYPE = "http";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.MCP_HTTP_PORT = String(port);
  process.env.MCP_LOG_LEVEL = "error";
  process.env.SANCTIONS_MIRROR_PATH = join(tempDir, "mcp-http-test.db");

  resetServerConfig();
  resetScreeningService();

  serverHandle = await createApp({
    name: "sanctions-screening-mcp-server",
    title: "sanctions-screening-mcp-server",
    tools: allToolDefinitions,
    resources: allResourceDefinitions,
    prompts: allPromptDefinitions,
    instructions:
      "Screen names against consolidated OFAC, EU, UK, UN, and BIS export-control watchlists and resolve legal entities against GLEIF, all fuzzy-matched offline over a local mirror.",
    async setup() {
      initScreeningService();
      const service = getScreeningService();
      await service.seedFixtures({
        designations: FIXTURE_DESIGNATIONS,
        leiEntities: FIXTURE_LEI_ENTITIES,
        leiRelationships: FIXTURE_LEI_RELATIONSHIPS,
      });
    },
  });

  mcpBaseUrl = `http://127.0.0.1:${port}/mcp`;
}, 30_000);

afterAll(async () => {
  await serverHandle?.shutdown("vitest");
  await getScreeningService()
    .close()
    .catch(() => undefined);
  resetScreeningService();
  delete process.env.MCP_TRANSPORT_TYPE;
  delete process.env.MCP_HTTP_HOST;
  delete process.env.MCP_HTTP_PORT;
  delete process.env.MCP_LOG_LEVEL;
  delete process.env.SANCTIONS_MIRROR_PATH;
  resetServerConfig();
  cleanupTempDir(tempDir);
});

describe("direct MCP HTTP server", () => {
  it("initializes a session and lists the registered screening tools", async () => {
    const { body, response } = await postJson<JsonRpcSuccess<InitializeResult>>(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest-direct-mcp", version: "1.0.0" },
        },
      },
    );

    expect(response.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo?.name).toBe("sanctions-screening-mcp-server");

    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initialized = await postJson<Record<string, unknown>>(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      sessionId ?? undefined,
    );
    expect(initialized.response.status).toBeLessThan(400);

    const tools = await postJson<JsonRpcSuccess<ToolsListResult>>(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      sessionId ?? undefined,
    );

    expect(tools.response.status).toBe(200);
    expect(tools.body.result.tools.map((tool) => tool.name)).toContain(
      "sanctions_screen_name",
    );
    expect(tools.body.result.tools.map((tool) => tool.name)).toContain(
      "sanctions_list_sources",
    );
  });

  it("calls sanctions_screen_name over MCP and returns structured hits", async () => {
    const init = await postJson<JsonRpcSuccess<InitializeResult>>({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest-direct-mcp", version: "1.0.0" },
      },
    });
    const sessionId = init.response.headers.get("mcp-session-id");

    await postJson<Record<string, unknown>>(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      sessionId ?? undefined,
    );

    const toolCall = await postJson<JsonRpcSuccess<ToolCallResult>>(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "sanctions_screen_name",
          arguments: {
            name: "Ivan Testovich Volkov",
          },
        },
      },
      sessionId ?? undefined,
    );

    expect(toolCall.response.status).toBe(200);
    expect(toolCall.body.result.structuredContent?.hits?.[0]?.primaryName).toBe(
      "Ivan Testovich Volkov",
    );
    expect(toolCall.body.result.structuredContent?.hits?.[0]?.source).toBe(
      "ofac_sdn",
    );
    expect(toolCall.body.result.structuredContent?.caveat).toContain(
      "not a compliance determination",
    );
    expect(
      toolCall.body.result.content?.some(
        (block) =>
          block.type === "text" &&
          block.text?.includes("Ivan Testovich Volkov"),
      ),
    ).toBe(true);
  });

  it("reads a designation resource over MCP without going through REST routes", async () => {
    const init = await postJson<JsonRpcSuccess<InitializeResult>>({
      jsonrpc: "2.0",
      id: 20,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest-direct-mcp", version: "1.0.0" },
      },
    });
    const sessionId = init.response.headers.get("mcp-session-id");

    await postJson<Record<string, unknown>>(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      sessionId ?? undefined,
    );

    const resourceRead = await postJson<JsonRpcSuccess<ResourceReadResult>>(
      {
        jsonrpc: "2.0",
        id: 21,
        method: "resources/read",
        params: {
          uri: "sanctions://designation/ofac_sdn/FX-1001",
        },
      },
      sessionId ?? undefined,
    );

    expect(resourceRead.response.status).toBe(200);
    expect(resourceRead.body.result.contents?.[0]?.uri).toBe(
      "sanctions://designation/ofac_sdn/FX-1001",
    );
    expect(resourceRead.body.result.contents?.[0]?.mimeType).toContain(
      "application/json",
    );
    expect(resourceRead.body.result.contents?.[0]?.text).toContain(
      "Ivan Testovich Volkov",
    );
  });
});
