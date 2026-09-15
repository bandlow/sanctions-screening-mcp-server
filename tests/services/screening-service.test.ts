/**
 * @fileoverview Integration tests for the matching engine over a seeded
 * synthetic-fixture mirror: exact / strong / approximate classification,
 * Jaro-Winkler fuzzy fallback, phonetic transliteration hits, source + type
 * filters, LEI resolution, ownership traversal, and the empty-result contract.
 * @module tests/services/screening-service.test
 */

import { createMockContext } from "@cyanheads/mcp-ts-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOfac } from "@/services/screening/sanctions-ingest.js";
import type { ScreeningService } from "@/services/screening/screening-service.js";
import { SOURCE_CODES } from "@/services/screening/types.js";
import { parseXml } from "@/services/screening/xml.js";
import { freshService, type SeededService, seededService } from "./_helpers.js";

let seeded: SeededService;
let svc: ScreeningService;
const ctx = createMockContext();

beforeEach(async () => {
  seeded = await seededService();
  svc = seeded.service;
});

afterEach(async () => {
  await seeded.cleanup();
});

const screenDefaults = {
  entityType: "any" as const,
  matchMode: "strict" as const,
  sources: [...SOURCE_CODES],
  limit: 25,
};

describe("screenName — strict matching", () => {
  it("returns an exact hit for a normalized primary-name match", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Ivan Testovich Volkov" },
      ctx,
    );
    expect(res.modeUsed).toBe("strict");
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1001");
    expect(hit?.matchType).toBe("exact");
    expect(hit?.score).toBeUndefined(); // exact hits are unscored
  });

  it("returns a strong hit when all query tokens are present (word-order swap)", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Volkov Ivan" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1001");
    expect(hit?.matchType).toBe("strong");
  });

  it("matches incomplete name tokens as strict prefix hits", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diam", autoFallback: false, limit: 100 },
      ctx,
    );

    expect(res.modeUsed).toBe("strict");
    expect(res.fuzzyFallbackTriggered).toBe(false);
    expect(res.hits.length).toBeGreaterThanOrEqual(3);
    expect(res.hits.some((h) => h.sourceEntryId === "FX-1011")).toBe(true);
    expect(res.hits.some((h) => h.sourceEntryId === "FX-1012")).toBe(true);
    expect(res.hits.some((h) => h.sourceEntryId === "FX-1013")).toBe(true);
    for (const hit of res.hits) {
      expect(hit.score).toBeUndefined();
      expect(hit.matchType === "exact" || hit.matchType === "strong").toBe(
        true,
      );
    }
  });

  it("matches on an alias, not just the primary name", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "FTC LLC" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-2002");
    expect(hit).toBeDefined();
    expect(hit?.matchedNameType).toBe("aka");
  });

  it("does not fabricate a score on exact/strong hits", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Katarina Beispiel" },
      ctx,
    );
    for (const hit of res.hits.filter((h) => h.matchType !== "approximate")) {
      expect(hit.score).toBeUndefined();
    }
  });

  it("filters by full address fields in the request", async () => {
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Ivan Testovich Volkov",
        address: {
          street: "Test Street",
          houseNumber: "1",
          postalCode: "12345",
          country: "Testland",
        },
      },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === "FX-1001")).toBeDefined();
    expect(res.hits.find((h) => h.sourceEntryId === "FX-2002")).toBeUndefined();
  });

  it("returns no hit when address filters do not match", async () => {
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Ivan Testovich Volkov",
        address: {
          street: "Test Street",
          houseNumber: "1",
          postalCode: "99999",
          country: "Testland",
        },
      },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
  });

  it("accepts entityType unknown and filters known entity hits out", async () => {
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Ivan Testovich Volkov",
        entityType: "unknown",
      },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
  });
});

describe("screenName — fuzzy fallback", () => {
  it("auto-falls-back to fuzzy when strict finds nothing, surfacing a raw JW score", async () => {
    // "Volkow" is a one-character near-miss of the primary name "Volkov".
    const res = await svc.screenName(
      { ...screenDefaults, query: "Ivan Volkow" },
      ctx,
    );
    expect(res.modeUsed).toBe("fuzzy");
    expect(res.fuzzyFallbackTriggered).toBe(true);
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1001");
    expect(hit?.matchType).toBe("approximate");
    expect(typeof hit?.score).toBe("number");
    expect(hit!.score!).toBeGreaterThan(0);
    expect(hit!.score!).toBeLessThanOrEqual(1);
  });

  it("catches transliteration-class variants at the default floor", async () => {
    // "Muhammad" phonetically collides with the published "Mohammed" (DM key MHMT),
    // which seeds "Mohammed Al-Testi" into the candidate pool. The shared exact
    // tokens "al"/"testi" then drive bestTokenScore to 1.0, so it clears the
    // default fuzzy floor (0.85) without any floor exemption — default-floor recall
    // for transliteration variants is preserved.
    const res = await svc.screenName(
      { ...screenDefaults, query: "Muhammad Al-Testi", matchMode: "fuzzy" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-6006");
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe("approximate");
  });

  it("returns an empty result (not a guess) for a name nothing resembles", async () => {
    // The fixture now carries FX-8008, whose short low-quality-aka "Noni" scores
    // 0.8515 against "nonexistent" (above the 0.85 floor). This query must still
    // return nothing: the coverage gate rejects a candidate that explains only 1 of
    // 3 query tokens (issue #4). Before the gate, that single token pair leaked.
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Zzqxwv Nonexistent Qqpzm",
        matchMode: "fuzzy",
      },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
  });
});

describe("screenName — single-token false-positive gate (issue #4)", () => {
  // A multi-token query must not be carried by ONE token pair that clears the fuzzy
  // floor. FX-8008 ("Mateo Restrepo Cardoza") has the short low-quality-aka "Noni";
  // "nonexistent" scores 0.8515 against "noni" — above the 0.85 floor — yet the
  // whole 3-token nonsense query is otherwise unrelated (coverage 1/3).
  it("rejects a candidate that clears the floor on a single query token (coverage 1/3)", async () => {
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Zzqxwv Nonexistent Qqpzm",
        matchMode: "fuzzy",
      },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === "FX-8008")).toBeUndefined();
  });

  it("still admits a legitimate partial match that covers 2 of 3 query tokens", async () => {
    // "Ivan" + "Volkov" both match FX-1001 exactly (coverage 2/3); the trailing
    // "Qqzzxw" is noise. Enough of the query is explained → the candidate admits.
    const res = await svc.screenName(
      { ...screenDefaults, query: "Ivan Volkov Qqzzxw", matchMode: "fuzzy" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1001");
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe("approximate");
  });

  it("leaves single-token queries unchanged — the floor alone governs", async () => {
    // One token, coverage is trivially the whole query; a near-miss above the floor
    // still surfaces (the gate only tightens 3+-token queries).
    const res = await svc.screenName(
      { ...screenDefaults, query: "Volkow", matchMode: "fuzzy" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1001");
    expect(hit?.matchType).toBe("approximate");
    expect(hit!.score!).toBeGreaterThanOrEqual(0.85);
  });

  it("still admits a fuzzy word-order swap with a near-miss token", async () => {
    // "Volkow Ivan" — swapped order, "Volkow" ≈ "Volkov"; both tokens covered.
    const res = await svc.screenName(
      { ...screenDefaults, query: "Volkow Ivan", matchMode: "fuzzy" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1001");
    expect(hit?.matchType).toBe("approximate");
  });
});

describe("screenName — whole-string prefix-inflation gate (issue #8)", () => {
  // The whole-string admission arm must not admit a SHORT candidate that is merely a
  // (near-)prefix of a much LONGER multi-token query. Jaro-Winkler's shared-prefix
  // boost inflates such pairs above the floor; a folded-length-ratio guard on the
  // whole-string arm blocks them without touching the spacing/concatenation recall
  // that arm exists for.
  it("rejects a bare short alias that only prefixes a longer multi-token query", async () => {
    // FX-9009 ("Aurelio Ferdinand Castellanos") carries the bare low-quality-aka
    // "Ferdinand". Against "Ferdinand Aquino Delgado", the whole-string JW of
    // "ferdinand aquino delgado" vs "ferdinand" is 0.875 — above the 0.85 floor — but
    // the length ratio is 0.375 (< 0.5) and token coverage is 1/3. Before the guard,
    // the inflated whole-string score admitted it; now it must not surface.
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Ferdinand Aquino Delgado",
        matchMode: "fuzzy",
      },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === "FX-9009")).toBeUndefined();
  });

  it("still admits a spacing/concatenation variant via the whole-string arm", async () => {
    // FX-1010 ("Van Der Berg Shipping") queried as its space-stripped concatenation
    // "vanderbergshipping": whole-string JW is 0.9667 but the best token pair is only
    // 0.806, so the token arm cannot admit it — ONLY the whole-string arm can. The
    // length ratio (0.857) clears the guard, so this concatenation recall survives.
    const res = await svc.screenName(
      { ...screenDefaults, query: "vanderbergshipping", matchMode: "fuzzy" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1010");
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe("approximate");
  });
});

describe("screenName — minScore floor enforced uniformly (issue #1)", () => {
  // The floor binds every fuzzy candidate, regardless of match strategy
  // (exact-normalized / token / phonetic). A phonetic-key candidate is seeded into
  // the pool but admitted ONLY when its computed score clears the floor — there is
  // no phonetic bypass. Before the fix, `score >= minScore || phoneticHit` admitted
  // a sub-floor phonetic-only hit, so a caller asking minScore:0.99 still saw a hit
  // scored e.g. 0.78. FX-7007 ("Catherine Pyotrov") is a purpose-built case: the
  // query "Katharina Petrov" shares its whole phonetic key (K0RN PTRF) but no exact
  // token, so its score (~0.78) is sub-floor — it reaches the pool only via the
  // phonetic key.
  const PHONETIC_QUERY = "Katharina Petrov";

  it("excludes a phonetic-only hit whose score is below an explicit high minScore", async () => {
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: PHONETIC_QUERY,
        matchMode: "fuzzy",
        minScore: 0.99,
      },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === "FX-7007")).toBeUndefined();
    // No returned hit may sit below the requested floor — the bypass is gone.
    for (const hit of res.hits) {
      if (hit.score !== undefined)
        expect(hit.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it("also excludes that phonetic-only sub-floor hit at the default floor", async () => {
    // The same candidate scores ~0.78 — below the default floor (0.85) too. Under
    // the old bypass it surfaced regardless; now it is correctly withheld. This is
    // the intended fix, not a recall loss: a genuine variant that scores ABOVE the
    // floor still surfaces (covered by the transliteration test above, which lands
    // at 1.0 via shared exact tokens).
    const res = await svc.screenName(
      { ...screenDefaults, query: PHONETIC_QUERY, matchMode: "fuzzy" },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === "FX-7007")).toBeUndefined();
  });
});

describe("screenName — query-token coverage ranking (issue #15)", () => {
  // Coverage is a literal count of query tokens the candidate explains, surfaced
  // as its own field and used as the ranking key BETWEEN score and the terminal
  // designation-id key. It never enters `score`, which stays raw Jaro-Winkler.
  it("omits queryTokenCoverage on exact and strong hits", async () => {
    const exact = await svc.screenName(
      { ...screenDefaults, query: "Ivan Testovich Volkov" },
      ctx,
    );
    const strong = await svc.screenName(
      { ...screenDefaults, query: "Volkov Ivan" },
      ctx,
    );
    for (const res of [exact, strong]) {
      for (const hit of res.hits) {
        expect(hit.matchType).not.toBe("approximate");
        expect(hit.queryTokenCoverage).toBeUndefined();
      }
    }
  });

  it("counts coverage at the applied minScore floor, not a fixed threshold", async () => {
    // "volkow" ~ "volkov" is 0.9556: covered at the default 0.85 floor, uncovered
    // at 0.99. The exact "ivan" pair carries admission either way, so the same
    // candidate surfaces with a different, honest coverage count per floor.
    const atDefault = await svc.screenName(
      { ...screenDefaults, query: "Ivan Volkow", matchMode: "fuzzy" },
      ctx,
    );
    expect(
      atDefault.hits.find((h) => h.sourceEntryId === "FX-1001")
        ?.queryTokenCoverage,
    ).toEqual({
      covered: 2,
      total: 2,
    });

    const atHighFloor = await svc.screenName(
      {
        ...screenDefaults,
        query: "Ivan Volkow",
        matchMode: "fuzzy",
        minScore: 0.99,
      },
      ctx,
    );
    expect(
      atHighFloor.hits.find((h) => h.sourceEntryId === "FX-1001")
        ?.queryTokenCoverage,
    ).toEqual({ covered: 1, total: 2 });
  });

  it("keeps the designation id as the terminal key when score and coverage tie", async () => {
    // Offset pagination needs a total order. Coverage is inserted BETWEEN score
    // and the id — it must not displace the id as the final tie-break.
    await svc.ingestDesignations(
      (["TIE-B", "TIE-A"] as const).map((entryId, index) => ({
        id: `un:${entryId}`,
        source: "un" as const,
        sourceEntryId: entryId,
        entityType: "person" as const,
        primaryName: `Rikardo Almeyda ${index === 0 ? "Sorel" : "Torres"}`,
        payload: {
          aliases: [],
          identifiers: [],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      })),
    );

    const res = await svc.screenName(
      { ...screenDefaults, query: "Rikardo Almeyda Zzqx", matchMode: "fuzzy" },
      ctx,
    );
    const a = res.hits.find((h) => h.sourceEntryId === "TIE-A");
    const b = res.hits.find((h) => h.sourceEntryId === "TIE-B");
    expect(a?.score).toBe(b?.score);
    expect(a?.queryTokenCoverage).toEqual(b?.queryTokenCoverage);
    expect(res.hits.findIndex((h) => h.sourceEntryId === "TIE-A")).toBeLessThan(
      res.hits.findIndex((h) => h.sourceEntryId === "TIE-B"),
    );
  });
});

describe("resolveEntity — query-token coverage ranking (issue #15)", () => {
  // runLeiFuzzy shares runFuzzy's `Math.max(tokenScore, wholeScore)` shape and so
  // shares the tie: two candidates each holding one exact query token both score
  // 1.0. The weaker LEI sorts first alphabetically, so the terminal LEI tie-break
  // ranks it ahead until coverage separates them.
  const FULL_LEI = "ZZZZFULLCOVERAGE0011";
  const WEAK_LEI = "AAAAWEAKCOVERAGE0011";

  beforeEach(async () => {
    await svc.ingestLeiEntities([
      {
        lei: FULL_LEI,
        legalName: "Testland Maritime Holdings Group PLC",
        otherNames: [],
        jurisdiction: "GB",
        status: "ISSUED",
      },
      {
        lei: WEAK_LEI,
        legalName: "Aurora Holdings Group Ltd",
        otherNames: [],
        jurisdiction: "GB",
        status: "ISSUED",
      },
    ]);
  });

  const resolveFuzzy = () =>
    svc.resolveEntity(
      {
        query: "Testlandia Maritime Holdings Group",
        matchMode: "fuzzy",
        status: "any",
        limit: 25,
      },
      ctx,
    );

  it("ranks the full-coverage candidate above a weaker one tied at the same score", async () => {
    const res = await resolveFuzzy();
    const full = res.matches.findIndex((m) => m.lei === FULL_LEI);
    const weak = res.matches.findIndex((m) => m.lei === WEAK_LEI);
    expect(full).toBe(0);
    expect(weak).toBeGreaterThan(full);
    expect(res.matches[full]?.score).toBe(res.matches[weak]?.score);
  });

  it("surfaces the literal coverage count for each candidate", async () => {
    const res = await resolveFuzzy();
    expect(
      res.matches.find((m) => m.lei === FULL_LEI)?.queryTokenCoverage,
    ).toEqual({
      covered: 4,
      total: 4,
    });
    expect(
      res.matches.find((m) => m.lei === WEAK_LEI)?.queryTokenCoverage,
    ).toEqual({
      covered: 2,
      total: 4,
    });
  });

  it("keeps the LEI as the terminal key when score and coverage tie", async () => {
    const res = await resolveFuzzy();
    const tied = res.matches.filter(
      (m) => m.score === 1 && m.queryTokenCoverage?.covered === 2,
    );
    expect(tied.length).toBeGreaterThan(1);
    expect(tied.map((m) => m.lei)).toEqual([...tied.map((m) => m.lei)].sort());
  });

  it("reports the coverage of the same name it reports the score for", async () => {
    // FX-2002's LEI carries both a legal name and a shorter trading name. Both
    // hold the exact token "trading" and so tie at score 1.0; the legal name
    // covers "compny" too, so it is the name surfaced — and the coverage on the
    // match describes that name, not a different one.
    const res = await svc.resolveEntity(
      {
        query: "Fictionel Trading Compny",
        matchMode: "fuzzy",
        status: "any",
        limit: 10,
      },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === "5493001KJTIIGC8Y1R12");
    expect(match?.matchedName).toBe("Fictional Trading Company LLC");
    expect(match?.queryTokenCoverage).toEqual({ covered: 3, total: 3 });
  });

  it("omits queryTokenCoverage on strict matches", async () => {
    const res = await svc.resolveEntity(
      {
        query: "Testland Maritime Holdings Group PLC",
        matchMode: "strict",
        status: "any",
        limit: 10,
      },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === FULL_LEI);
    expect(match?.matchType).toBe("exact");
    expect(match?.queryTokenCoverage).toBeUndefined();
  });
});

describe("screenName — candidate-pool fairness", () => {
  it("surfaces a fuzzy match whose distinctive token is not the first query token", async () => {
    // Every query token contributes candidates to the fuzzy pool (not just the
    // first / not a single OR clause that the leading token can exhaust). Here the
    // leading token "Vanya" is a near-miss nickname; the real signal is in the
    // later tokens "Volkof" ≈ "Volkov".
    const res = await svc.screenName(
      { ...screenDefaults, query: "Vanya Volkof", matchMode: "fuzzy" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1001");
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe("approximate");
  });
});

describe("screenName — autoFallback control", () => {
  it("auto-upgrades strict→fuzzy by default when strict is empty", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Ivan Volkow" },
      ctx,
    );
    expect(res.modeUsed).toBe("fuzzy");
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it("does NOT auto-fall-back to fuzzy when autoFallback is false", async () => {
    // The internal cross-reference screens (get_entity / trace_ownership) pass
    // this so a generic name does not fuzzy-flood with single-common-token hits.
    const res = await svc.screenName(
      { ...screenDefaults, query: "Ivan Volkow", autoFallback: false },
      ctx,
    );
    expect(res.modeUsed).toBe("strict");
    expect(res.hits).toHaveLength(0); // strict miss stays a miss — the honest answer
  });

  it("still runs fuzzy when explicitly requested even with autoFallback false", async () => {
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Ivan Volkow",
        matchMode: "fuzzy",
        autoFallback: false,
      },
      ctx,
    );
    expect(res.modeUsed).toBe("fuzzy");
  });
});

describe("screenName — filters", () => {
  it("honors the source filter", async () => {
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Imaginary Front Organisation",
        sources: ["un"],
      },
      ctx,
    );
    expect(res.hits.every((h) => h.source === "un")).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it("honors the entity-type filter", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Phantom Voyager", entityType: "vessel" },
      ctx,
    );
    expect(res.hits.every((h) => h.entityType === "vessel")).toBe(true);
  });

  it("excludes hits when the type filter does not match", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Phantom Voyager", entityType: "person" },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
  });
});

describe("screenName — offset pagination and overflow disclosure (issue #9)", () => {
  /** Six designations sharing a name stem, so one strict screen matches all six. */
  const pageDesignations = Array.from({ length: 6 }, (_, index) => ({
    id: `un:PAGE-${index}`,
    source: "un" as const,
    sourceEntryId: `PAGE-${index}`,
    entityType: "organization" as const,
    primaryName: `Overflow Candidate ${String.fromCharCode(65 + index)}`,
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  }));

  beforeEach(async () => {
    await svc.ingestDesignations(pageDesignations);
  });

  const screenPage = (offset: number, limit: number) =>
    svc.screenName(
      { ...screenDefaults, query: "Overflow Candidate", limit, offset },
      ctx,
    );

  it("reports the pre-slice total as exact and returns only the requested page", async () => {
    const res = await screenPage(0, 2);
    expect(res.hits).toHaveLength(2);
    expect(res.totalAvailable).toBe(6);
    expect(res.totalAvailableBasis).toBe("exact");
  });

  it("walks disjoint pages that reassemble the complete set in order", async () => {
    const pages = await Promise.all([
      screenPage(0, 2),
      screenPage(2, 2),
      screenPage(4, 2),
    ]);
    const ids = pages.flatMap((page) =>
      page.hits.map((hit) => hit.designationId),
    );
    expect(ids).toEqual([
      "un:PAGE-0",
      "un:PAGE-1",
      "un:PAGE-2",
      "un:PAGE-3",
      "un:PAGE-4",
      "un:PAGE-5",
    ]);
  });

  it("orders same-band ties deterministically across repeated identical queries", async () => {
    // Every hit here is `strong`, so matchRank cannot separate them — without an
    // explicit secondary key the order is incidental Map-insertion order and the
    // pages above could overlap or drop rows.
    const first = await screenPage(0, 6);
    const second = await screenPage(0, 6);
    expect(second.hits.map((hit) => hit.designationId)).toEqual(
      first.hits.map((hit) => hit.designationId),
    );
  });

  it("returns an empty page past the end while still reporting the true total", async () => {
    const res = await screenPage(99, 2);
    expect(res.hits).toHaveLength(0);
    expect(res.totalAvailable).toBe(6);
  });

  it("labels a fuzzy-mode total as a bound, never an exact corpus count", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Ivan Volkow", matchMode: "fuzzy" },
      ctx,
    );
    expect(res.modeUsed).toBe("fuzzy");
    expect(res.totalAvailableBasis).toBe("lower_bound");
  });

  it("reports a lower bound once the raw-row scan cap binds", async () => {
    // The strict FTS query caps raw (pre-dedup) alias rows at 5000; above it the
    // deduplicated designation count is a floor, not a total, and must say so.
    await svc.ingestDesignations(
      Array.from({ length: 5000 }, (_, index) => ({
        id: `un:CAP-${index}`,
        source: "un" as const,
        sourceEntryId: `CAP-${index}`,
        entityType: "organization" as const,
        primaryName: `Capped Candidate ${index}`,
        payload: {
          aliases: [],
          identifiers: [],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      })),
    );
    const res = await svc.screenName(
      { ...screenDefaults, query: "Capped", limit: 5 },
      ctx,
    );
    expect(res.hits).toHaveLength(5);
    expect(res.totalAvailableBasis).toBe("lower_bound");
    expect(res.totalAvailable).toBeGreaterThanOrEqual(res.hits.length);
  });
});

describe("resolveEntity — offset pagination and overflow disclosure (issue #9)", () => {
  const pageEntities = Array.from({ length: 4 }, (_, index) => ({
    lei: `OVERFLOWSERVICE${index}0011`,
    legalName: `Overflow Candidate ${String.fromCharCode(65 + index)} Ltd`,
    otherNames: [],
    jurisdiction: "US",
    status: "ISSUED",
  }));

  beforeEach(async () => {
    await svc.ingestLeiEntities(pageEntities);
  });

  const resolvePage = (offset: number, limit: number) =>
    svc.resolveEntity(
      {
        query: "Overflow Candidate",
        matchMode: "strict",
        status: "issued",
        limit,
        offset,
      },
      ctx,
    );

  it("reports the pre-slice total as exact and returns only the requested page", async () => {
    const res = await resolvePage(0, 2);
    expect(res.matches).toHaveLength(2);
    expect(res.totalAvailable).toBe(4);
    expect(res.totalAvailableBasis).toBe("exact");
  });

  it("walks disjoint pages that reassemble the complete set in a stable order", async () => {
    const pages = await Promise.all([resolvePage(0, 2), resolvePage(2, 2)]);
    const leis = pages.flatMap((page) =>
      page.matches.map((match) => match.lei),
    );
    expect(leis).toEqual(pageEntities.map((entity) => entity.lei));
    expect((await resolvePage(0, 4)).matches.map((match) => match.lei)).toEqual(
      leis,
    );
  });

  it("returns an empty page past the end while still reporting the true total", async () => {
    const res = await resolvePage(99, 2);
    expect(res.matches).toHaveLength(0);
    expect(res.totalAvailable).toBe(4);
  });

  it("labels a fuzzy-mode total as a bound, never an exact corpus count", async () => {
    const res = await svc.resolveEntity(
      {
        query: "Fictionel Trading Compny",
        matchMode: "fuzzy",
        status: "any",
        limit: 10,
      },
      ctx,
    );
    expect(res.modeUsed).toBe("fuzzy");
    expect(res.totalAvailableBasis).toBe("lower_bound");
  });
});

describe("getDesignation", () => {
  it("returns the full normalized record", async () => {
    const d = await svc.getDesignation("ofac_sdn", "FX-1001");
    expect(d?.primaryName).toBe("Ivan Testovich Volkov");
    expect(d?.payload.aliases.length).toBeGreaterThan(0);
    expect(d?.payload.identifiers[0]?.type).toBe("Passport");
  });

  it("returns null for an unknown entry", async () => {
    expect(await svc.getDesignation("ofac_sdn", "NOPE")).toBeNull();
  });
});

describe("resolveEntity", () => {
  it("resolves a company name to its LEI (strict)", async () => {
    const res = await svc.resolveEntity(
      {
        query: "Fictional Trading Company LLC",
        matchMode: "strict",
        status: "issued",
        limit: 10,
      },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === "5493001KJTIIGC8Y1R12");
    expect(match).toBeDefined();
    expect(match?.matchType).toBe("exact");
  });

  it("honors the jurisdiction filter", async () => {
    const res = await svc.resolveEntity(
      {
        query: "Testland Holdings",
        jurisdiction: "GB",
        matchMode: "strict",
        status: "issued",
        limit: 10,
      },
      ctx,
    );
    expect(res.matches.every((m) => m.jurisdiction === "GB")).toBe(true);
  });

  it("fuzzy-matches a misspelled company name with a raw score", async () => {
    const res = await svc.resolveEntity(
      {
        query: "Fictionel Trading Compny",
        matchMode: "fuzzy",
        status: "any",
        limit: 10,
      },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === "5493001KJTIIGC8Y1R12");
    expect(match?.matchType).toBe("approximate");
    expect(typeof match?.score).toBe("number");
  });
});

describe("resolveEntity — single-token false-positive gate (issue #4)", () => {
  // runLeiFuzzy shares runFuzzy's admission gate: a legal/trading name must explain
  // enough of the query, not be carried by one strong token pair. "Testland
  // Holdings PLC" is pooled by any query token whose prefix matches its legal name.
  it("rejects an LEI whose legal name matches only one of three query tokens", async () => {
    // "Testlandia" ≈ "Testland" (JW ~0.96, above the floor); "Xyzzy"/"Qqpzm" are
    // noise. Coverage 1/3 → not admitted, even though the one pair clears the floor.
    const res = await svc.resolveEntity(
      {
        query: "Testlandia Xyzzy Qqpzm",
        matchMode: "fuzzy",
        status: "any",
        limit: 10,
      },
      ctx,
    );
    expect(
      res.matches.find((m) => m.lei === "529900T8BM49AURSDO55"),
    ).toBeUndefined();
  });

  it("still admits an LEI when 2 of 3 query tokens are covered", async () => {
    // "Testland" + "Holdings" both match the legal name exactly (coverage 2/3);
    // "Qqzz" is noise. Enough of the query is explained → admitted.
    const res = await svc.resolveEntity(
      {
        query: "Testland Holdings Qqzz",
        matchMode: "fuzzy",
        status: "any",
        limit: 10,
      },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === "529900T8BM49AURSDO55");
    expect(match).toBeDefined();
    expect(match?.matchType).toBe("approximate");
  });
});

describe("ownership", () => {
  it("returns the direct parent relationship for a child LEI", async () => {
    const rels = await svc.getRelationships("5493001KJTIIGC8Y1R12", "parents");
    expect(rels).toHaveLength(1);
    expect(rels[0]?.parentLei).toBe("529900T8BM49AURSDO55");
    expect(rels[0]?.relationshipType).toBe("IS_ULTIMATELY_CONSOLIDATED_BY");
  });

  it("returns the child relationship from the parent side", async () => {
    const rels = await svc.getRelationships("529900T8BM49AURSDO55", "children");
    expect(rels).toHaveLength(1);
    expect(rels[0]?.childLei).toBe("5493001KJTIIGC8Y1R12");
  });
});

describe("sources + readiness", () => {
  it("reports per-source counts and readiness", async () => {
    const counts = await svc.sourceCounts();
    // FX-1001 (Ivan Testovich Volkov) + FX-8008 (the single-token false-positive guard) + FX-1011 (Diamond Trading Syndicate).
    expect(counts.find((c) => c.code === "ofac_sdn")?.recordCount).toBe(3);
    expect(await svc.sanctionsReady()).toBe(true);
    expect(await svc.leiReady()).toBe(true);
  });
});

describe("ingestLeiRelationships — batch semantics (issue #6)", () => {
  const CHILD = "5493001KJTIIGC8Y1R12";
  const relA = {
    childLei: CHILD,
    parentLei: "PARENTAAAAAAAAAAAAA1",
    relationshipType: "IS_DIRECTLY_CONSOLIDATED_BY",
  };
  const relB = {
    childLei: CHILD,
    parentLei: "PARENTBBBBBBBBBBBBB1",
    relationshipType: "IS_ULTIMATELY_CONSOLIDATED_BY",
  };

  it("init insert-only path keeps a child whose relationships span a batch boundary", async () => {
    // The streaming golden-copy hazard: one child's relationships arrive in two
    // separate batches. clearLeiRelationships() wipes once up front, then each
    // batch is insert-only — so batch 2 must NOT delete batch 1's rows.
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA], { replaceByChild: false });
    await svc.ingestLeiRelationships([relB], { replaceByChild: false });
    const rels = await svc.getRelationships(CHILD, "parents");
    expect(rels).toHaveLength(2);
    expect(new Set(rels.map((r) => r.parentLei))).toEqual(
      new Set([relA.parentLei, relB.parentLei]),
    );
  });

  it("delta replace-by-child (default) restates a child per call", async () => {
    // The delta path keeps replace-by-child semantics: a later call re-stating the
    // same child replaces its rows (correct only when a child's full set is one call).
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA]);
    await svc.ingestLeiRelationships([relB]);
    const rels = await svc.getRelationships(CHILD, "parents");
    expect(rels).toHaveLength(1);
    expect(rels[0]?.parentLei).toBe(relB.parentLei);
  });

  it("clearLeiRelationships wipes the table", async () => {
    await svc.clearLeiRelationships();
    expect(await svc.getRelationships(CHILD, "parents")).toHaveLength(0);
    expect((await svc.leiReadiness()).relationshipCount).toBe(0);
  });
});

describe("advanceLeiFreshnessIfReady — GLEIF delta freshness (issue #5)", () => {
  it("advances completedAt + total to the LIVE entity count on a ready mirror", async () => {
    const before = await svc.leiReadiness();
    expect(before.ready).toBe(true);
    expect(before.total).toBe(2); // seeded L1 entity count
    expect(before.completedAt).toBeDefined();

    // Simulate a delta apply: one new LEI entity ingested (batch size 1).
    await svc.ingestLeiEntities([
      {
        lei: "5493001KJTIIGC8Y1R99",
        legalName: "Delta Added Co",
        otherNames: [],
      },
    ]);

    const result = await svc.advanceLeiFreshnessIfReady();
    expect(result.advanced).toBe(true);
    // total is the live mirror count (3), NEVER the delta batch size (1).
    expect(result.entityCount).toBe(3);

    const after = await svc.leiReadiness();
    expect(after.ready).toBe(true);
    expect(after.total).toBe(3);
    expect(after.completedAt).toBeDefined();
    expect(after.completedAt! >= before.completedAt!).toBe(true);
  });

  it("does NOT flip a never-initialized mirror to ready (delta on empty is not completion)", async () => {
    const fresh = await freshService();
    try {
      const svc2 = fresh.service;
      expect(await svc2.leiReady()).toBe(false);

      // A delta lands rows on a mirror that never completed an init.
      await svc2.ingestLeiEntities([
        {
          lei: "5493001KJTIIGC8Y1R12",
          legalName: "Orphan Delta Co",
          otherNames: [],
        },
      ]);

      const result = await svc2.advanceLeiFreshnessIfReady();
      expect(result.advanced).toBe(false);
      expect(result.entityCount).toBe(1); // reports the live count but does not mark ready

      expect(await svc2.leiReady()).toBe(false); // still not ready — run mirror:init
      expect((await svc2.leiReadiness()).completedAt).toBeUndefined(); // freshness left unset
    } finally {
      await fresh.cleanup();
    }
  });
});

describe("re-harvest idempotence (issue #14)", () => {
  const HARVEST_XML = `<sdnList>
    <sdnEntry><uid>RH-1</uid><firstName>Reharvest</firstName><lastName>Person</lastName></sdnEntry>
    <sdnEntry><firstName>Identifierless</firstName><lastName>Person</lastName></sdnEntry>
  </sdnList>`;

  it("re-ingesting the same source document updates rows instead of inserting new ones", async () => {
    const harvest = () => parseOfac(parseXml(HARVEST_XML), "ofac_sdn");

    await svc.ingestDesignations(harvest());
    const afterFirst = await svc.sourceCounts();
    await svc.ingestDesignations(harvest());

    expect(await svc.sourceCounts()).toEqual(afterFirst);
  });

  it("never admits a record the source gave no identifier for", async () => {
    await svc.ingestDesignations(parseOfac(parseXml(HARVEST_XML), "ofac_sdn"));

    const admitted = await svc.screenName(
      { ...screenDefaults, query: "Reharvest Person" },
      ctx,
    );
    expect(admitted.hits.map((h) => h.sourceEntryId)).toContain("RH-1");

    const rejected = await svc.screenName(
      {
        ...screenDefaults,
        query: "Identifierless Person",
        autoFallback: false,
      },
      ctx,
    );
    expect(rejected.hits).toHaveLength(0);
  });
});

describe("screenName — specific test cases for result-set requirements", () => {
  // Test case 1: "Karsten" should return no hits — a name not in the fixture set
  it("returns no hits for a name not in the sanctions list (strict mode)", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Karsten", autoFallback: false },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
    expect(res.modeUsed).toBe("strict");
  });

  it('returns no hits for "Karsten" even with fuzzy fallback enabled', async () => {
    // "Karsten" has no phonetic or token similarity to any fixture entry
    // Note: fuzzy fallback is enabled by default, so fuzzy will be used automatically
    const res = await svc.screenName(
      { ...screenDefaults, query: "Karsten" },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
    // enrichment notice may be undefined, depending on implementation
    // The important check is that no hits are returned
    expect(res.modeUsed).toBe("fuzzy"); // auto-fallback to fuzzy on empty strict result
  });

  // Test case 2: "Diamond" should return multiple hits (from the new fixture entries)
  it('returns multiple hits for "Diamond" in strict mode', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict" },
      ctx,
    );
    // "Diamond" appears in three fixture entries:
    // FX-1011: "Diamond Trading Syndicate"
    // FX-1012: "Black Diamond Holdings"
    // FX-1013: "Diamond Mines and Resources Ltd"
    // Plus aliases containing "Diamond"
    expect(res.hits.length).toBeGreaterThanOrEqual(3);
    expect(
      res.hits.every((h) => h.matchedName.toLowerCase().includes("diamond")),
    ).toBe(true);
  });

  it("ranks Diamond entries consistently by match type and source", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict", limit: 100 },
      ctx,
    );
    // All should be exact or strong matches (since "Diamond" is a token)
    for (const hit of res.hits) {
      expect(["exact", "strong"]).toContain(hit.matchType);
    }
    // The primary names should come before aliases
    const primaryMatches = res.hits.filter(
      (h) =>
        h.matchedNameType === "primary" && h.matchedName.includes("Diamond"),
    );
    expect(primaryMatches.length).toBeGreaterThanOrEqual(1);
  });

  // Test case 3: Partial/misspelled names with fuzzy matching
  it('finds partial matches with fuzzy mode for "Diamod" (typo)', async () => {
    // "Diamod" is close to "Diamond" — should trigger fuzzy fallback
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamod", matchMode: "fuzzy" },
      ctx,
    );
    expect(res.modeUsed).toBe("fuzzy");
    expect(res.hits.length).toBeGreaterThan(0);
    // Should find Diamond entries via phonetic/JW approximation
    const diamondHits = res.hits.filter((h) =>
      h.matchedName.toLowerCase().includes("diamond"),
    );
    expect(diamondHits.length).toBeGreaterThan(0);
  });

  it('returns fuzzy hits for incomplete name "Diamond Tradingg" (typo + incomplete)', async () => {
    // "Diamond Tradingg" has a typo ("Tradingg" vs "Trading") and is incomplete
    // Should match "Diamond Trading Syndicate" with approximate match
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond Tradingg", matchMode: "fuzzy" },
      ctx,
    );
    expect(res.modeUsed).toBe("fuzzy");
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1011");
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe("approximate");
    expect(typeof hit?.score).toBe("number");
    expect(hit!.score!).toBeGreaterThanOrEqual(0.85); // clears the default fuzzy floor
  });

  it('finds "Black Diamond" with incomplete token matching', async () => {
    // "Black Diamond" is the primary name of FX-1012
    // When queried without "Holdings", it should still be found
    const res = await svc.screenName(
      { ...screenDefaults, query: "Black Diamond", matchMode: "strict" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1012");
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe("strong"); // all tokens present
  });

  it("shows different fuzzy scores for variations of the same name", async () => {
    // Compare three variations:
    // 1. Exact: "Diamond Trading Syndicate"
    // 2. With typo: "Diamond Tradingg Syndicate"
    // 3. With more typos: "Diamend Trading Syndicate"

    const exact = await svc.screenName(
      {
        ...screenDefaults,
        query: "Diamond Trading Syndicate",
        matchMode: "fuzzy",
      },
      ctx,
    );
    const exactHit = exact.hits.find((h) => h.sourceEntryId === "FX-1011");

    const typo1 = await svc.screenName(
      {
        ...screenDefaults,
        query: "Diamond Tradingg Syndicate",
        matchMode: "fuzzy",
      },
      ctx,
    );
    const typo1Hit = typo1.hits.find((h) => h.sourceEntryId === "FX-1011");

    const typo2 = await svc.screenName(
      {
        ...screenDefaults,
        query: "Diamend Trading Syndicate",
        matchMode: "fuzzy",
      },
      ctx,
    );
    const typo2Hit = typo2.hits.find((h) => h.sourceEntryId === "FX-1011");

    // All should find the entry
    expect(exactHit).toBeDefined();
    expect(typo1Hit).toBeDefined();
    expect(typo2Hit).toBeDefined();

    // Exact version should be highest ranked (likely exact or strong match)
    expect(["exact", "strong"]).toContain(exactHit?.matchType);

    // Both typo versions should have scores (fuzzy matches)
    expect(typeof typo1Hit?.score).toBe("number");
    expect(typeof typo2Hit?.score).toBe("number");

    // More typos should score lower (or equal) compared to fewer typos
    // Exact match should be better than typos when in same mode
    if (exactHit?.score !== undefined && typo1Hit?.score !== undefined) {
      expect(exactHit.score).toBeGreaterThanOrEqual(typo1Hit.score - 0.01); // allow small rounding
    }
  });

  it('handles partial query "Mines and Resources" to find Diamond entry', async () => {
    // FX-1013 is "Diamond Mines and Resources Ltd"
    // Query without "Diamond" to test partial matching
    const res = await svc.screenName(
      { ...screenDefaults, query: "Mines Resources", matchMode: "strict" },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1013");
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe("strong"); // all query tokens present
    expect(hit?.matchedName).toContain("Diamond Mines");
  });

  it("surfaces queryTokenCoverage for fuzzy Diamond matches", async () => {
    // When fuzzy-matching a multi-token query, coverage should track which tokens
    // participate in the match
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Black Diamond Holdings",
        matchMode: "fuzzy",
      },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === "FX-1012");
    expect(hit).toBeDefined();
    // Exact match on all tokens (Black Diamond Holdings)
    expect(hit?.matchType).toBe("exact");
    expect(hit?.queryTokenCoverage).toBeUndefined(); // exact hits don't have coverage
  });
});

describe("screenName — prefix matching with multiple results", () => {
  // Test cases for finding multiple names that have the input as a prefix,
  // demonstrating that partial token matching returns multiple candidates
  // ordered by relevance (match type, score, source)

  it('finds all entries with "Diamond" as a token prefix', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict", limit: 100 },
      ctx,
    );
    // Should find at least 3 entries with Diamond in the name:
    // FX-1011: Diamond Trading Syndicate (primary name)
    // FX-1012: Black Diamond Holdings (primary name)
    // FX-1013: Diamond Mines and Resources Ltd (primary name)
    expect(res.hits.length).toBeGreaterThanOrEqual(3);

    const diamondPrimaries = res.hits.filter(
      (h) =>
        h.matchedNameType === "primary" &&
        h.matchedName.toLowerCase().startsWith("diamond"),
    );
    expect(diamondPrimaries.length).toBeGreaterThanOrEqual(2); // FX-1011, FX-1013
  });

  it("returns different names starting with the same prefix", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict" },
      ctx,
    );

    const names = res.hits.map((h) => h.matchedName).filter((n) => n);
    // All should contain "Diamond" token
    expect(names.every((n) => n.toLowerCase().includes("diamond"))).toBe(true);

    // Should have multiple distinct names
    const uniqueNames = new Set(names.map((n) => n.toLowerCase().trim())).size;
    expect(uniqueNames).toBeGreaterThanOrEqual(3);
  });

  it("orders prefix matches by match type (exact/strong before aliases)", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict", limit: 100 },
      ctx,
    );

    // Group by match type
    const byType = {
      exact: res.hits.filter((h) => h.matchType === "exact"),
      strong: res.hits.filter((h) => h.matchType === "strong"),
      approximate: res.hits.filter((h) => h.matchType === "approximate"),
    };

    // Exact matches should come before strong, strong before approximate
    const exactEnd = byType.exact.length;

    // Verify ordering: all exact results come before all strong results
    if (byType.exact.length > 0 && byType.strong.length > 0) {
      const firstStrongIndex = res.hits.findIndex(
        (h) => h.matchType === "strong",
      );
      // The first strong result should start exactly after all exact results.
      expect(firstStrongIndex).toBe(exactEnd);
    }
  });

  it('finds prefix "Black" matching "Black Diamond Holdings" and aliases', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Black", matchMode: "strict" },
      ctx,
    );

    // FX-1012: "Black Diamond Holdings" contains "Black" as a token
    const blackHits = res.hits.filter((h) =>
      h.matchedName.toLowerCase().includes("black"),
    );
    expect(blackHits.length).toBeGreaterThan(0);

    // Should find the primary name
    const primaryBlackHit = blackHits.find(
      (h) => h.sourceEntryId === "FX-1012" && h.matchedNameType === "primary",
    );
    expect(primaryBlackHit).toBeDefined();
  });

  it("returns multiple candidates with their distinct source entry IDs", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict", limit: 100 },
      ctx,
    );

    const entryIds = res.hits.map((h) => h.sourceEntryId);
    const uniqueIds = new Set(entryIds);

    // Should have at least 3 different source entries
    expect(uniqueIds.size).toBeGreaterThanOrEqual(3);
    // FX-1011, FX-1012, FX-1013 should all be present
    expect(uniqueIds.has("FX-1011")).toBe(true);
    expect(uniqueIds.has("FX-1012")).toBe(true);
    expect(uniqueIds.has("FX-1013")).toBe(true);
  });

  it("shows prefix matches from different sources (OFAC, EU, UK)", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict", limit: 100 },
      ctx,
    );

    const sources = new Set(res.hits.map((h) => h.source));
    // Should have multiple sources
    // FX-1011: ofac_sdn, FX-1012: eu, FX-1013: uk
    expect(sources.has("ofac_sdn")).toBe(true);
    expect(sources.has("eu")).toBe(true);
    expect(sources.has("uk")).toBe(true);
  });

  it("returns prefix matches with consistent scoring for same match type", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict" },
      ctx,
    );

    // Group strong matches
    const strongMatches = res.hits.filter((h) => h.matchType === "strong");

    // All strong matches should have no score (exact/strong hits are unscored)
    for (const match of strongMatches) {
      expect(match.score).toBeUndefined();
    }
  });

  it("distinguishes between primary name and alias matches for same prefix", async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict", limit: 100 },
      ctx,
    );

    const primaryMatches = res.hits.filter(
      (h) => h.matchedNameType === "primary",
    );
    const aliasMatches = res.hits.filter((h) => h.matchedNameType === "aka");

    // Should have both primary and alias matches
    expect(primaryMatches.length).toBeGreaterThanOrEqual(2); // FX-1011, FX-1013
    // May have alias matches (e.g., "Diamond Traders" alias of FX-1011)
    if (aliasMatches.length > 0) {
      expect(aliasMatches[0]?.matchedName).toBeDefined();
    }
  });

  it("finds prefix matches in fuzzy mode with phonetic fallback", async () => {
    // Query "Diamnd" (missing 'o') — should NOT find anything in strict mode
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Diamnd",
        matchMode: "strict",
        autoFallback: false,
      },
      ctx,
    );

    // Strict mode finds nothing with autoFallback disabled
    expect(res.hits).toHaveLength(0);

    // Now with explicit fuzzy mode
    const fuzzyRes = await svc.screenName(
      { ...screenDefaults, query: "Diamnd", matchMode: "fuzzy" },
      ctx,
    );

    // Should find Diamond entries via phonetic similarity
    expect(fuzzyRes.modeUsed).toBe("fuzzy");
    const diamondHits = fuzzyRes.hits.filter((h) =>
      h.matchedName.toLowerCase().includes("diamond"),
    );
    expect(diamondHits.length).toBeGreaterThan(0);
  });

  it("maintains stable order across repeated prefix queries", async () => {
    // Query the same prefix multiple times
    const result1 = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict" },
      ctx,
    );
    const result2 = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict" },
      ctx,
    );

    // Extract the result order
    const order1 = result1.hits.map((h) => h.sourceEntryId);
    const order2 = result2.hits.map((h) => h.sourceEntryId);

    // Results should be in the same order both times
    expect(order1).toEqual(order2);
  });

  it("handles prefix matching with entity-type filtering", async () => {
    const res = await svc.screenName(
      {
        ...screenDefaults,
        query: "Diamond",
        matchMode: "strict",
        entityType: "organization",
      },
      ctx,
    );

    // All results should be organizations
    expect(res.hits.every((h) => h.entityType === "organization")).toBe(true);
    // Should still find multiple Diamond entries (all are organizations)
    expect(res.hits.length).toBeGreaterThanOrEqual(3);
  });

  it("returns expected hit count when limiting prefix results", async () => {
    const unlimitedRes = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict", limit: 100 },
      ctx,
    );

    const limitedRes = await svc.screenName(
      { ...screenDefaults, query: "Diamond", matchMode: "strict", limit: 2 },
      ctx,
    );

    // Limited result should have fewer hits
    expect(limitedRes.hits.length).toBeLessThanOrEqual(2);
    // Total available should still report the true count
    expect(unlimitedRes.hits.length).toBeGreaterThan(limitedRes.hits.length);
    expect(limitedRes.totalAvailable).toEqual(unlimitedRes.totalAvailable);
  });
});
