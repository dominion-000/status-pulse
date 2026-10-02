# Status Pulse: User Flows

> **Requirement: Learner-designed flows.** One flow per role, with failure branches shown. Diagrams are Mermaid, which renders on GitHub.

## 1. Developer / Project Owner

```mermaid
flowchart TD
  A["Register or log in"] --> B["Create project: creator becomes Owner"]
  B --> C["Register service: URL, method, interval, timeout, expected response, thresholds, public or private"]
  C -->|"invalid or unsafe"| C1["422 listing the failing fields"]
  C --> D["Saved as config version 1, audit row written"]
  D --> E["First check runs within seconds"]
  E --> F["Result stored, status calculated"]
  F --> G["Unknown until the first result, Operational after the first pass"]
  G --> H["Checks continue every interval"]
  H --> I["Owner edits service: validated, new version, audit row"]
  H --> J["Owner disables service: checks stop, status Unknown, hidden from public page"]
  H --> K["Owner sets override: reason and expiry required"]
  K --> L["Override status shows, new incidents and alerts suppressed"]
  L --> M["Expiry or cancel: computed status resumes"]
  B --> N["Invite members as Responder or Viewer"]
```

Session handling: the access token lasts 15 minutes. When it expires, the client sends its refresh token and receives a new pair. If the refresh token is expired or revoked, the user logs in again.

## 2. Incident Responder

```mermaid
flowchart TD
  A["Failures reach the service's fail threshold"] -->|"override active"| A1["No incident, no alert"]
  A --> B["One transaction: result stored, status Outage, incident Investigating, alert created"]
  B --> C{"Alert delivered?"}
  C -->|"no"| D["delivered_at stays empty, retry scheduled"]
  D --> C
  C -->|"yes"| E["Responder sees the alert"]
  E --> F["Acknowledge: who and when recorded"]
  F --> G["Post updates, each marked public or internal"]
  G --> H["Identified"]
  H --> I["Monitoring"]
  I --> J["Resolved by a responder"]
  G -.->|"skipping a stage"| X["409 invalid transition"]
```

The system never resolves an incident on its own. Passing checks bring the service back to Operational, and a responder decides when the incident is resolved.

## 3. Public Viewer / Subscriber

```mermaid
flowchart TD
  A["Open the public status page"] --> B["See public services, active public incidents, recent history"]
  B --> C["Subscribe: email and chosen public services"]
  C -->|"too many requests"| C1["429"]
  C --> D["Verification email written to the outbox"]
  D --> E["Open the verification link"]
  E -->|"expired or already used"| E1["410"]
  E --> F["Subscription active"]
  F --> G["Public update on a subscribed service"]
  G --> H["Simulated notification sent"]
```

Subscribing twice with the same email does not create a second subscription. Private services are never listed and cannot be subscribed to.

## 4. Administrator

```mermaid
flowchart TD
  A["Log in as administrator"] --> B["Scheduler failures"]
  A --> C["Worker retries and failed alert deliveries"]
  A --> D["Audit trail, filtered by actor or entity"]
  A --> E["Access changes"]
  C --> F["Retry a failed alert delivery"]
```

## Rules behind the flows

1. **Thresholds belong to the service.** The owner sets how many consecutive failures cause an outage, how many consecutive passes cause recovery, and for Degraded both a latency limit and how many slow results in a row count as degraded.
2. **Status.** A new service is Unknown. A first passing result makes it Operational. Moving into Degraded or Outage needs the full threshold. Recovery steps from Outage to Degraded to Operational, each step after the recovery threshold of consecutive passes. No result within three intervals returns the service to Unknown.
3. **One transaction.** Saving the result, updating the status, opening the incident and creating the alert happen together or not at all. If a worker crashes midway nothing is half-written, its job lease expires, and another worker retries the job.
4. **One active incident per service**, enforced by the database. Two workers finishing checks for the same service at the same moment cannot open two incidents.
5. **Visibility.** An incident takes its service's public or private setting. An incident on a private service can never be public. The owner may hide an incident of a public service. Each update is public or internal, and an update on a non-public incident is always internal.
6. **Override.** While active it shows instead of the computed status. Checks keep being recorded, but no new incident or alert is created. An incident that is already open is untouched. When the override ends, the computed status resumes and may open an incident then.
7. **Disabled service.** No checks, status shows Unknown, and it does not appear on the public page. Re-enabling resumes checks.
8. **Every change is audited** with who did it and when: service configuration, overrides, member roles, incident and acknowledgement actions, plan changes.
