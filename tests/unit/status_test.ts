import { describe, expect, it } from "vitest";
import {
  evaluate,
  evaluationWindow,
  type CheckSample,
  type EvaluationInput,
  type ServiceStatus,
  type Thresholds,
} from "../../src/core/status";

const NOW = new Date("2026-10-05T12:00:00Z");
const thresholds: Thresholds = { failThreshold: 3, recoveryThreshold: 2, slowThreshold: 3, degradedMs: 1000, intervalSeconds: 60 };

// Compact notation: p = fast pass, s = slow pass, f = failure.
const seq = (s: string): CheckSample[] =>
  [...s].map((c) => (c === "f" ? { passed: false, latencyMs: null } : { passed: true, latencyMs: c === "s" ? 2500 : 120 }));

function status(previous: ServiceStatus, results: string, overrides: Partial<EvaluationInput> = {}) {
  return evaluate({
    previous,
    results: seq(results),
    lastResultAt: new Date(NOW.getTime() - 10_000),
    enabled: true,
    thresholds,
    override: null,
    now: NOW,
    ...overrides,
  });
}

describe("from Unknown (SP-04.7)", () => {
  it.each([
    ["", "Unknown"],
    ["p", "Operational"],
    ["s", "Operational"],
    ["f", "Unknown"],
    ["ff", "Unknown"],
    ["fff", "Outage"],
    ["ffp", "Operational"],
    ["fffff", "Outage"],
  ])("results %j give %s", (results, expected) => {
    expect(status("Unknown", results).computed).toBe(expected);
  });
});

describe("from Operational (SP-04.2)", () => {
  it.each([
    ["", "Operational"],
    ["pppp", "Operational"],
    ["ff", "Operational"],
    ["fff", "Outage"],
    ["ffpff", "Operational"], // a pass restarts the failure streak
    ["ssf", "Operational"], // a failure restarts the slow streak
    ["ss", "Operational"],
    ["sss", "Degraded"],
    ["sspss", "Operational"], // a fast pass restarts the slow streak
    ["pppsss", "Degraded"],
  ])("results %j give %s", (results, expected) => {
    expect(status("Operational", results).computed).toBe(expected);
  });

  it("never becomes Degraded when the service has no latency limit", () => {
    const noLimit = { ...thresholds, degradedMs: null };
    expect(status("Operational", "sssss", { thresholds: noLimit }).computed).toBe("Operational");
  });

  it("uses the thresholds of the service", () => {
    expect(status("Operational", "f", { thresholds: { ...thresholds, failThreshold: 1 } }).computed).toBe("Outage");
  });
});

describe("from Degraded: only fast passes recover it", () => {
  it.each([
    ["", "Degraded"],
    ["p", "Degraded"],
    ["pp", "Operational"],
    ["spp", "Operational"],
    ["psp", "Degraded"], // a slow result restarts the count
    ["ss", "Degraded"],
    ["pf", "Degraded"],
    ["fff", "Outage"],
  ])("results %j give %s", (results, expected) => {
    expect(status("Degraded", results).computed).toBe(expected);
  });
});

describe("from Outage: recovery steps through Degraded (SP-04.3)", () => {
  it.each([
    ["", "Outage"],
    ["f", "Outage"],
    ["p", "Outage"],
    ["pp", "Degraded"],
    ["fpp", "Degraded"],
    ["pfp", "Outage"], // a failure restarts the streak
    ["pfpp", "Degraded"],
  ])("results %j give %s", (results, expected) => {
    expect(status("Outage", results).computed).toBe(expected);
  });

  describe("one slow-but-successful result may count, once", () => {
    it.each([
      ["sp", "Degraded"], // the first result after the outage is slow: the service was waking up
      ["fsp", "Degraded"],
      ["ss", "Outage"], // the second slow result does not count and restarts the streak
      ["ps", "Outage"], // a slow result after a fast pass does not count
      ["ssp", "Outage"],
      ["sspp", "Degraded"], // after the restart, two fast passes recover it
      ["psp", "Outage"],
    ])("results %j give %s", (results, expected) => {
      expect(status("Outage", results).computed).toBe(expected);
    });

    it("does not allow the slow result when the service has no latency limit to exceed", () => {
      expect(status("Outage", "pp", { thresholds: { ...thresholds, degradedMs: null } }).computed).toBe("Degraded");
    });
  });

  it("needs each recovery step to be earned with new results", () => {
    expect(status("Outage", "pp").computed).toBe("Degraded");
    // the caller then passes only results recorded after that transition
    expect(status("Degraded", "").computed).toBe("Degraded");
    expect(status("Degraded", "pp").computed).toBe("Operational");
  });
});

describe("stale results and disabled services (SP-04.6, SP-02.9)", () => {
  const intervalMs = thresholds.intervalSeconds * 1000;

  it("is Unknown when there has been no result for more than three intervals", () => {
    const e = status("Operational", "pppp", { lastResultAt: new Date(NOW.getTime() - 3 * intervalMs - 1) });
    expect(e.computed).toBe("Unknown");
    expect(e.source).toBe("stale");
  });

  it("is still current at exactly three intervals", () => {
    const e = status("Operational", "pppp", { lastResultAt: new Date(NOW.getTime() - 3 * intervalMs) });
    expect(e.computed).toBe("Operational");
  });

  it("is Unknown when there never was a result", () => {
    expect(status("Operational", "", { lastResultAt: null }).computed).toBe("Unknown");
  });

  it("goes Unknown from Outage as well, without opening anything new", () => {
    expect(status("Outage", "fff", { lastResultAt: new Date(NOW.getTime() - 10 * intervalMs) }).computed).toBe("Unknown");
  });

  it("is Unknown when disabled, whatever the results say", () => {
    const e = status("Operational", "pppp", { enabled: false });
    expect(e.computed).toBe("Unknown");
    expect(e.source).toBe("disabled");
  });
});

describe("overrides (SP-04.5, SP-04.8)", () => {
  const active = { status: "Operational" as const, expiresAt: new Date(NOW.getTime() + 3_600_000) };

  it("shows the override while the computed status keeps following the results", () => {
    const e = status("Operational", "fff", { override: active });
    expect(e.computed).toBe("Outage");
    expect(e.displayed).toBe("Operational");
    expect(e.overrideActive).toBe(true);
    expect(e.source).toBe("override");
  });

  it("stops applying at its expiry, and the computed status resumes", () => {
    const expired = { ...active, expiresAt: NOW };
    const e = status("Operational", "fff", { override: expired });
    expect(e.overrideActive).toBe(false);
    expect(e.displayed).toBe("Outage");
    expect(e.source).toBe("computed");
  });

  it("applies over a stale service too", () => {
    const e = status("Operational", "pppp", { override: active, lastResultAt: new Date(NOW.getTime() - 3_600_000) });
    expect(e.computed).toBe("Unknown");
    expect(e.displayed).toBe("Operational");
  });

  it("is ignored on a disabled service", () => {
    const e = status("Operational", "pppp", { override: active, enabled: false });
    expect(e.displayed).toBe("Unknown");
    expect(e.overrideActive).toBe(false);
  });
});

describe("evaluate is a pure function", () => {
  it("gives the same answer for the same input", () => {
    expect(status("Outage", "sspp")).toEqual(status("Outage", "sspp"));
  });

  it("gives the same answer when given more history than the window needs", () => {
    const window = evaluationWindow(thresholds);
    const long = "p".repeat(50) + "fff";
    const tail = long.slice(-window);
    expect(status("Operational", long).computed).toBe(status("Operational", tail).computed);
    expect(status("Operational", long).computed).toBe("Outage");
  });
});
