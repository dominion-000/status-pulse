// Incident lifecycle and visibility rules (SP-05). Pure: no database, no I/O.
import type { Evaluation, ServiceStatus } from "./status";

export type IncidentStatus =
  "Investigating" | "Identified" | "Monitoring" | "Resolved";

/** The only order an incident can move through. */
export const INCIDENT_ORDER: readonly IncidentStatus[] = [
  "Investigating",
  "Identified",
  "Monitoring",
  "Resolved",
];

/** An incident is active until it is resolved. The database allows one active incident per service. */
export function isActive(status: IncidentStatus): boolean {
  return status !== "Resolved";
}

export function nextIncidentStatus(
  status: IncidentStatus,
): IncidentStatus | null {
  return INCIDENT_ORDER[INCIDENT_ORDER.indexOf(status) + 1] ?? null;
}

/** A message for the 409 response when the move is not allowed, or null when it is (SP-05.3). */
export function transitionIssue(
  from: IncidentStatus,
  to: IncidentStatus,
): string | null {
  const next = nextIncidentStatus(from);
  if (next === null) return `the incident is already ${from}`;
  if (to === next) return null;
  return `cannot move from ${from} to ${to}; the next status is ${next}`;
}

// The stored flag is only a wish. Whether an incident is public is derived every time it is read, so an
// incident on a private service is never public, even if the service was public when the flag was set.
export function isIncidentPublic(
  flag: boolean,
  serviceIsPublic: boolean,
): boolean {
  return flag && serviceIsPublic;
}

/** An update is public only when it is marked public and its incident is public. */
export function isUpdatePublic(
  updateFlag: boolean,
  incidentFlag: boolean,
  serviceIsPublic: boolean,
): boolean {
  return updateFlag && isIncidentPublic(incidentFlag, serviceIsPublic);
}

/** The flag a new incident starts with: it follows its service. */
export function defaultIncidentFlag(serviceIsPublic: boolean): boolean {
  return serviceIsPublic;
}

/** A message when an incident cannot be made public because its service is private, or null. */
export function visibilityChangeIssue(
  wantPublic: boolean,
  serviceIsPublic: boolean,
): string | null {
  return wantPublic && !serviceIsPublic
    ? "an incident on a private service cannot be made public"
    : null;
}

// when an incident opens (SP-05.1, SP-04.8)

export interface OpenDecisionInput {
  /** The status that was shown before this evaluation. */
  previousDisplayed: ServiceStatus;
  evaluation: Evaluation;
  hasActiveIncident: boolean;
}

/**
 * An incident opens when the shown status turns into Outage, no override is active and none is already open.
 * Using the shown status covers both cases: a result pushes the service into Outage, and an override ends
 * while the service is still down. An override that is active opens nothing, and a responder who resolves an
 * incident while the service is still down does not reopen one on the next result, because the shown status
 * does not change. The partial unique index in the database remains the last safety point.
 */
export function shouldOpenIncident(input: OpenDecisionInput): boolean {
  const { previousDisplayed, evaluation, hasActiveIncident } = input;
  return (
    evaluation.displayed === "Outage" &&
    previousDisplayed !== "Outage" &&
    !evaluation.overrideActive &&
    !hasActiveIncident
  );
}
