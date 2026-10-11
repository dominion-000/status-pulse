import { describe, expect, it } from "vitest";
import {
  INCIDENT_ORDER,
  defaultIncidentFlag,
  isActive,
  isIncidentPublic,
  isUpdatePublic,
  nextIncidentStatus,
  shouldOpenIncident,
  transitionIssue,
  visibilityChangeIssue,
  type IncidentStatus,
} from "../../src/core/incident";
import type { Evaluation, ServiceStatus } from "../../src/core/status";

describe("incident lifecycle (SP-05.3)", () => {
  it("allows only the next status", () => {
    expect(transitionIssue("Investigating", "Identified")).toBeNull();
    expect(transitionIssue("Identified", "Monitoring")).toBeNull();
    expect(transitionIssue("Monitoring", "Resolved")).toBeNull();
  });

  const all = INCIDENT_ORDER;
  it("refuses every other move, with a message naming the next status", () => {
    for (const from of all) {
      for (const to of all) {
        const next = nextIncidentStatus(from);
        if (to === next) continue;
        const issue = transitionIssue(from, to);
        expect(issue, `${from} -> ${to}`).not.toBeNull();
        if (next) expect(issue).toContain(next);
      }
    }
  });

  it.each<[IncidentStatus, IncidentStatus]>([
    ["Investigating", "Monitoring"], // skipping
    ["Investigating", "Resolved"],
    ["Identified", "Investigating"], // going back
    ["Resolved", "Monitoring"],
    ["Monitoring", "Monitoring"], // staying
  ])("refuses %s to %s", (from, to) => {
    expect(transitionIssue(from, to)).not.toBeNull();
  });

  it("says a resolved incident is finished", () => {
    expect(transitionIssue("Resolved", "Investigating")).toBe("the incident is already Resolved");
    expect(nextIncidentStatus("Resolved")).toBeNull();
  });

  it("is active until resolved", () => {
    expect(INCIDENT_ORDER.filter(isActive)).toEqual(["Investigating", "Identified", "Monitoring"]);
  });
});

describe("visibility (SP-05.5)", () => {
  it.each([
    // flag, service public, expected
    [true, true, true],
    [true, false, false], // an incident on a private service is never public
    [false, true, false], // the owner hid it
    [false, false, false],
  ])("incident flag %s on a service that is public=%s is public=%s", (flag, servicePublic, expected) => {
    expect(isIncidentPublic(flag, servicePublic)).toBe(expected);
  });

  it.each([
    // update flag, incident flag, service public, expected
    [true, true, true, true],
    [true, false, true, false], // internal incident: every update is internal
    [true, true, false, false], // private service: nothing is public
    [false, true, true, false], // an internal update on a public incident
    [false, false, false, false],
  ])("update flag %s, incident flag %s, service public=%s gives %s", (u, i, s, expected) => {
    expect(isUpdatePublic(u, i, s)).toBe(expected);
  });

  it("starts an incident with its service's setting", () => {
    expect(defaultIncidentFlag(true)).toBe(true);
    expect(defaultIncidentFlag(false)).toBe(false);
  });

  it("lets the owner hide an incident, but not publish one on a private service", () => {
    expect(visibilityChangeIssue(false, true)).toBeNull();
    expect(visibilityChangeIssue(false, false)).toBeNull();
    expect(visibilityChangeIssue(true, true)).toBeNull();
    expect(visibilityChangeIssue(true, false)).toContain("private service");
  });
});

describe("when an incident opens (SP-05.1, SP-04.8)", () => {
  const evaluation = (displayed: ServiceStatus, overrideActive = false): Evaluation => ({
    computed: displayed,
    displayed,
    overrideActive,
    source: overrideActive ? "override" : "computed",
  });

  it("opens when the shown status turns into Outage", () => {
    for (const previousDisplayed of ["Operational", "Degraded", "Unknown"] as const) {
      expect(shouldOpenIncident({ previousDisplayed, evaluation: evaluation("Outage"), hasActiveIncident: false })).toBe(true);
    }
  });

  it("does not open again while the service stays in Outage", () => {
    expect(shouldOpenIncident({ previousDisplayed: "Outage", evaluation: evaluation("Outage"), hasActiveIncident: false })).toBe(false);
  });

  it("does not open when one is already active", () => {
    expect(shouldOpenIncident({ previousDisplayed: "Operational", evaluation: evaluation("Outage"), hasActiveIncident: true })).toBe(false);
  });

  it("does not open while an override is active", () => {
    const masked: Evaluation = { computed: "Outage", displayed: "Operational", overrideActive: true, source: "override" };
    expect(shouldOpenIncident({ previousDisplayed: "Operational", evaluation: masked, hasActiveIncident: false })).toBe(false);
  });

  it("opens when an override ends while the service is still down", () => {
    expect(shouldOpenIncident({ previousDisplayed: "Operational", evaluation: evaluation("Outage"), hasActiveIncident: false })).toBe(true);
  });

  it("does not open for any other status", () => {
    for (const displayed of ["Operational", "Degraded", "Unknown"] as const) {
      expect(shouldOpenIncident({ previousDisplayed: "Outage", evaluation: evaluation(displayed), hasActiveIncident: false })).toBe(false);
    }
  });

  it("does not reopen after a responder resolves an incident while the service is still down", () => {
    expect(shouldOpenIncident({ previousDisplayed: "Outage", evaluation: evaluation("Outage"), hasActiveIncident: false })).toBe(false);
  });
});
