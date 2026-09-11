/**
 * @fileoverview REST facade integration coverage for screening and discovery routes.
 * @module tests/rest/rest-facade.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NormalizedDesignation } from '@/services/screening/types.js';

const httpPort = 38010;
const restBaseUrl = `http://127.0.0.1:${httpPort + 1}`;

const REST_VESSEL_FIXTURE: NormalizedDesignation = {
  id: 'ofac_sdn:FX-REST-VESSEL-1',
  source: 'ofac_sdn',
  sourceEntryId: 'FX-REST-VESSEL-1',
  entityType: 'vessel',
  primaryName: 'MV REST FACADE TEST',
  program: 'TEST-VESSEL',
  designationDate: '2026-09-07',
  payload: {
    aliases: [{ name: 'REST TEST SHIP', nameType: 'aka' }],
    identifiers: [{ type: 'Vessel Registration Identification', value: 'IMO 9218478' }],
    addresses: [],
    datesOfBirth: [],
    nationalities: [],
    vesselDetails: {
      flag: 'Iran',
      formerFlags: ['Malta'],
      vesselType: 'Crude Oil Tanker',
      callSigns: ['9HEG9'],
      tonnage: '297013',
    },
  },
};

let stopRestFacade: (() => Promise<void>) | undefined;
let mcpProxyTarget: Server | undefined;
let tempDir = '';
let closeScreeningService: (() => Promise<void>) | undefined;
let resetScreeningServiceFn: (() => void) | undefined;
let resetServerConfigFn: (() => void) | undefined;

beforeAll(async () => {
  process.env.MCP_TRANSPORT_TYPE = 'http';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.MCP_HTTP_PORT = String(httpPort);
  mcpProxyTarget = createServer((req, res) => {
    if (req.url === '/mcp') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proxied: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) =>
    mcpProxyTarget?.listen(httpPort, '127.0.0.1', resolve),
  );
  tempDir = mkdtempSync(join(tmpdir(), 'sanctions-rest-test-'));
  process.env.SANCTIONS_MIRROR_PATH = join(tempDir, 'test.db');

  vi.resetModules();

  const { resetServerConfig } = await import('@/config/server-config.js');
  const { getScreeningService, initScreeningService, resetScreeningService } = await import(
    '@/services/screening/screening-service.js'
  );
  const { FIXTURE_DESIGNATIONS, FIXTURE_LEI_ENTITIES, FIXTURE_LEI_RELATIONSHIPS } = await import(
    '@/services/screening/fixtures.js'
  );

  resetServerConfig();
  resetScreeningService();
  initScreeningService();
  const service = getScreeningService();
  await service.seedFixtures({
    designations: [...FIXTURE_DESIGNATIONS, REST_VESSEL_FIXTURE],
    leiEntities: FIXTURE_LEI_ENTITIES,
    leiRelationships: FIXTURE_LEI_RELATIONSHIPS,
  });

  closeScreeningService = () => service.close();
  resetScreeningServiceFn = resetScreeningService;
  resetServerConfigFn = resetServerConfig;

  const rest = await import('@/rest/rest-facade.js');
  stopRestFacade = rest.stopRestFacade;
  await rest.startRestFacade();
}, 30_000);

afterAll(async () => {
  await stopRestFacade?.();
  await new Promise<void>((resolve, reject) => {
    mcpProxyTarget?.close((error) => (error ? reject(error) : resolve()));
  });
  await closeScreeningService?.();
  resetScreeningServiceFn?.();
  try {
    rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  } catch {
    // Windows can transiently hold SQLite files; cleanup failures are non-fatal.
  }

  delete process.env.MCP_TRANSPORT_TYPE;
  delete process.env.MCP_HTTP_HOST;
  delete process.env.MCP_HTTP_PORT;
  delete process.env.REST_HTTP_PORT;
  delete process.env.REST_MCP_PROXY_HOST;
  delete process.env.SANCTIONS_MIRROR_PATH;
  resetServerConfigFn?.();

  vi.resetModules();
});

describe('REST facade compliance-case endpoints', () => {
  it('returns designation details including vessel metadata via REST', async () => {
    const response = await fetch(`${restBaseUrl}/api/v1/designations/ofac_sdn/FX-REST-VESSEL-1`);
    const payload = (await response.json()) as {
      designation: {
        source: string;
        sourceEntryId: string;
        entityType: string;
        vesselDetails?: {
          flag?: string;
          formerFlags: string[];
          vesselType?: string;
          callSigns: string[];
          tonnage?: string;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.designation.source).toBe('ofac_sdn');
    expect(payload.designation.sourceEntryId).toBe('FX-REST-VESSEL-1');
    expect(payload.designation.entityType).toBe('vessel');
    expect(payload.designation.vesselDetails).toEqual({
      flag: 'Iran',
      formerFlags: ['Malta'],
      vesselType: 'Crude Oil Tanker',
      callSigns: ['9HEG9'],
      tonnage: '297013',
    });
  });

  it('returns designation_not_found for unknown designation details', async () => {
    const response = await fetch(`${restBaseUrl}/api/v1/designations/ofac_sdn/DOES-NOT-EXIST`);
    const payload = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('designation_not_found');
  });

  it('serves OpenAPI YAML and Swagger UI endpoints', async () => {
    const specResponse = await fetch(`${restBaseUrl}/api/v1/openapi.yaml`);
    const specBody = await specResponse.text();

    expect(specResponse.status).toBe(200);
    expect(specResponse.headers.get('content-type')).toContain('application/yaml');
    expect(specBody).toContain('openapi: 3.1.0');
    expect(specBody).toContain('/screening/business-partner');
    expect(specBody).toContain('/designations/{source}/{entryId}');

    const uiResponse = await fetch(`${restBaseUrl}/ui/swagger`);
    const uiBody = await uiResponse.text();

    expect(uiResponse.status).toBe(200);
    expect(uiResponse.headers.get('content-type')).toContain('text/html');
    expect(uiBody).toContain('SwaggerUIBundle');
    expect(uiBody).toContain('/api/v1/openapi.yaml');
    expect(uiBody).toContain('/ui/swagger-ui.css');
    expect(uiBody).toContain('/ui/swagger-ui-bundle.js');

    const cssResponse = await fetch(`${restBaseUrl}/ui/swagger-ui.css`);
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toContain('text/css');

    const bundleResponse = await fetch(`${restBaseUrl}/ui/swagger-ui-bundle.js`);
    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.headers.get('content-type')).toContain('application/javascript');
  });

  it('proxies MCP requests through the public REST listener', async () => {
    const response = await fetch(`${restBaseUrl}/mcp`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ proxied: true });
  });

});
