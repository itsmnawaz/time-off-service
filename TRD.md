# Technical Requirements Document
## Time-Off Microservice — ExampleHR × HCM Integration

**Author:** Muhammad Nawaz  
**Version:** 1.0  
**Status:** Final  
**Date:** May 2026

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [User Personas and Requirements](#3-user-personas-and-requirements)
4. [Key Engineering Challenges](#4-key-engineering-challenges)
5. [Proposed Solution](#5-proposed-solution)
6. [Data Model](#6-data-model)
7. [API Design](#7-api-design)
8. [State Machine: Request Lifecycle](#8-state-machine-request-lifecycle)
9. [Balance Sync Architecture](#9-balance-sync-architecture)
10. [Alternatives Considered](#10-alternatives-considered)
11. [Error Handling and Defensive Design](#11-error-handling-and-defensive-design)
12. [Test Strategy](#12-test-strategy)
13. [Operational Considerations](#13-operational-considerations)
14. [Open Questions and Future Work](#14-open-questions-and-future-work)

---

## 1. Problem Statement

ExampleHR needs a backend microservice to manage the lifecycle of employee time-off requests and keep leave balances in sync with a third-party Human Capital Management (HCM) system (e.g. Workday, SAP SuccessFactors).

The HCM is the **source of truth** for leave balances. ExampleHR needs to:
- Provide employees with accurate, real-time balance visibility.
- Let employees submit requests and get instant feedback without waiting for HCM round-trips on every action.
- Ensure that any deduction made in ExampleHR is faithfully committed to HCM.
- Detect and reconcile balance changes that HCM applies independently (e.g. work-anniversary credits, year-start refresh).

The fundamental tension is: **ExampleHR must act quickly for user experience, while HCM must remain authoritative for correctness.**

---

## 2. Goals and Non-Goals

### Goals
- Manage the full lifecycle of a time-off request: submit → approve/reject → commit to HCM → cancel.
- Maintain per-employee, per-location balance records locally, with continuous reconciliation against HCM.
- Support three sync paths: real-time balance check, HCM-push webhook, and nightly batch reconciliation.
- Never allow an employee to go over-balance, even under concurrent requests.
- Provide a complete audit trail of every balance change and request state transition.
- Be defensively correct when HCM is unavailable (degrade gracefully, do not corrupt state).

### Non-Goals
- Authentication and authorisation of end-users (assumed handled by an API gateway).
- Multi-leave-type balance aggregation per employee (balances are per employee × location × leave-type; this service treats each HCM-provided balance record as a unit).
- HCM system provisioning or employee record management.
- UI layer.

---

## 3. User Personas and Requirements

### Employee
| # | Requirement |
|---|-------------|
| E1 | See my current available balance for each location. |
| E2 | Submit a time-off request and get immediate confirmation (or rejection for insufficient balance). |
| E3 | Cancel a pending or approved request and have my balance restored. |
| E4 | See accurate balance even if HCM applied a bonus since I last checked. |

### Manager
| # | Requirement |
|---|-------------|
| M1 | Approve or reject a pending request, knowing the balance shown is valid. |
| M2 | Rejected requests must not deduct from the employee's balance. |
| M3 | Approved requests must be committed to HCM before being considered final. |

### Operations / Admin
| # | Requirement |
|---|-------------|
| O1 | Trigger a manual full sync with HCM at any time. |
| O2 | Observe a sync history log with status and record counts. |
| O3 | Retry HCM submissions that failed after approval. |
| O4 | Receive webhook push from HCM for out-of-band balance changes. |

---

## 4. Key Engineering Challenges

### Challenge 1: Dual-write consistency (ExampleHR ↔ HCM)
When a manager approves a request, we need to write to both ExampleHR's local DB and to HCM. Neither of these is transactional with the other. If the HCM call fails after we record the approval locally, we have a split-brain state.

**Root cause:** No distributed transaction spanning ExampleHR's DB and HCM's HTTP API.

### Challenge 2: Out-of-band HCM mutations
HCM can change balances at any time without notifying ExampleHR — e.g. an employee's 5-year anniversary adds 2 bonus days. ExampleHR's local balance becomes stale.

**Root cause:** HCM does not guarantee change-stream delivery; our local cache can drift.

### Challenge 3: Preventing double-spend under concurrency
If two requests arrive simultaneously for the same employee, both may pass the balance check before either has committed its deduction. Classic TOCTOU (time-of-check to time-of-use) race.

**Root cause:** Balance check and deduction are not atomic without explicit locking.

### Challenge 4: HCM may not always return errors for invalid requests
The spec notes HCM *should* return errors for insufficient balance or bad dimensions, but this is not guaranteed. We must not rely solely on HCM as a guard.

**Root cause:** External system reliability — we cannot trust HCM as a complete validator.

### Challenge 5: Reconciling pending deductions during batch sync
If a batch sync runs while a request is in PENDING state (local deduction applied, not yet committed to HCM), naively overwriting localBalance with the HCM value would lose track of the in-flight deduction.

**Root cause:** Batch sync is full-replacement of balances, but pending requests represent future deductions not yet visible in HCM.

---

## 5. Proposed Solution

### Architecture Overview

```
Employee/Manager
      │
      ▼
[API Gateway]  ──auth──►  [Time-Off Microservice]
                                │         │
                    ┌───────────┘         └────────────┐
                    ▼                                   ▼
            [SQLite/sql.js DB]               [HCM System]
            (local state)              (source of truth)
                    │
            ┌───────┴───────┐
            │               │
        [Balances]     [Requests]
        [AuditLog]     [SyncLogs]
```

### Core Design Decisions

#### Decision 1: Optimistic local deduction with deferred HCM commit

When an employee submits a request, we immediately deduct from a `pendingDeductions` counter (not `localBalance`) in a DB transaction. This:
- Gives instant feedback on insufficient balance.
- Guards against concurrent double-spend (DB transaction with row-level semantics).
- Does not prematurely reduce `localBalance` before HCM confirms.

When the manager **approves**, we push the deduction to HCM. On success we commit (reduce `localBalance`, clear `pendingDeductions`). On failure we mark `HCM_FAILED` and retry.

#### Decision 2: Separate `localBalance` and `hcmBalance` columns

`hcmBalance` records the last value HCM returned. `localBalance` is what ExampleHR believes is the current truth. They diverge only briefly:
- Immediately after an HCM-side bonus (detected on next GET or batch sync).
- During `HCM_FAILED` windows.

This gives the drift-detection mechanism a clean signal: if `localBalance ≠ hcmBalance`, something changed in HCM we don't know about.

#### Decision 3: Preserving `pendingDeductions` across batch sync

During batch reconciliation, we update `localBalance = hcmBalance = new_hcm_value` but **leave `pendingDeductions` untouched**. This is the key invariant:

```
availableBalance = localBalance − pendingDeductions
```

Pending deductions represent work in flight. HCM does not know about them yet (they're pre-approval or pre-commit). Wiping them during sync would make over-balance submission possible.

#### Decision 4: Three sync paths, escalating cost

| Path | Trigger | Latency | Coverage |
|------|---------|---------|----------|
| Real-time GET | Every `GET /balances` | ~200ms | Single employee |
| Webhook | HCM pushes to `/sync/webhook` | Seconds | Single employee |
| Batch | Nightly cron (configurable) | Minutes | All employees |

Real-time is the first line of defence. Webhook is event-driven and precise. Batch is the safety net — it reconciles everything HCM knows.

#### Decision 5: HCM_FAILED is a recoverable state, not a terminal one

When HCM is unavailable at approval time, we mark the request `HCM_FAILED`. The pending deduction stays in place so the employee's available balance reflects the expected deduction. The nightly batch sync retries all `HCM_FAILED` requests with `hcmRetryCount < 3`. After 3 failures, human intervention is required.

---

## 6. Data Model

### `balances`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Surrogate key |
| `employeeId` | VARCHAR | Business key (from HCM) |
| `locationId` | VARCHAR | Business key (from HCM) |
| `localBalance` | FLOAT | ExampleHR's view of the balance (= last hcmBalance after sync) |
| `hcmBalance` | FLOAT | Last value returned by HCM (drift detection signal) |
| `pendingDeductions` | FLOAT | Sum of days in PENDING/APPROVED requests not yet committed to HCM |
| `lastHcmSyncAt` | TIMESTAMP | Last successful HCM read |
| `version` | INT | Optimistic lock counter |

**Unique constraint:** `(employeeId, locationId)`

### `time_off_requests`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `employeeId` | VARCHAR | |
| `locationId` | VARCHAR | |
| `leaveType` | ENUM | VACATION / SICK / PERSONAL / BEREAVEMENT / OTHER |
| `daysRequested` | FLOAT | Supports half-days |
| `startDate` / `endDate` | VARCHAR | ISO date strings |
| `status` | ENUM | See state machine |
| `reason` | TEXT | Employee note |
| `managerComment` | TEXT | |
| `reviewedBy` / `reviewedAt` | VARCHAR / TIMESTAMP | |
| `hcmTransactionId` | VARCHAR | HCM's transaction reference |
| `hcmSubmittedAt` | TIMESTAMP | |
| `hcmRetryCount` | INT | For retry throttle |
| `hcmLastErrorMessage` | TEXT | |

### `sync_logs`

Operational record of every batch/webhook/realtime sync run with status, record counts, and error details.

### `audit_logs`

Immutable append-only log of every balance change and request state transition, with before/after snapshots.

---

## 7. API Design

All endpoints return RFC 7807 Problem Details on error.

### Balance Endpoints

```
GET  /balances/:employeeId/:locationId
```
Returns current balance. Triggers a live HCM fetch; if HCM is unavailable, returns cached data with `"hcmUnavailable": true`.

**Response:**
```json
{
  "employeeId": "emp-123",
  "locationId": "us-east",
  "localBalance": 10.0,
  "hcmBalance": 10.0,
  "pendingDeductions": 3.0,
  "availableBalance": 7.0,
  "lastHcmSyncAt": "2026-05-12T00:00:00Z"
}
```

```
POST /balances/upsert
```
Admin endpoint to manually push a balance update (e.g. from internal tools).

### Request Endpoints

```
GET    /requests                   Query: employeeId, status, locationId
GET    /requests/:id
POST   /requests                   Employee submits
PATCH  /requests/:id/review        Manager approves or rejects
DELETE /requests/:id               Employee or admin cancels
POST   /requests/:id/retry-hcm    Admin retries HCM_FAILED submission
```

**Create request body:**
```json
{
  "employeeId": "emp-123",
  "locationId": "us-east",
  "leaveType": "VACATION",
  "daysRequested": 3,
  "startDate": "2026-06-01",
  "endDate": "2026-06-03",
  "reason": "Family holiday"
}
```

**Review body:**
```json
{
  "status": "APPROVED",
  "reviewedBy": "mgr-456",
  "managerComment": "Approved"
}
```

### Sync Endpoints

```
POST /sync/webhook    HCM pushes a single balance update
POST /sync/manual     Admin triggers immediate batch sync (async)
GET  /sync/history    Recent sync run log
```

**Webhook body:**
```json
{
  "employeeId": "emp-123",
  "locationId": "us-east",
  "balance": 15.0
}
```

---

## 8. State Machine: Request Lifecycle

```
                    submit()
                    ┌────────────────────────────────────────────────────┐
                    │  [balance check + pending deduction applied]       │
                    ▼                                                    │
               ┌─────────┐                                              │
               │ PENDING │                                              │
               └────┬────┘                                              │
          ┌─────────┴─────────┐                                         │
      reject()             approve()                                    │
          │         [pending deduction stays,                           │
          │          HCM push attempted]                                │
          ▼                   ▼                                         │
    ┌──────────┐        ┌──────────┐                                    │
    │ REJECTED │        │ APPROVED │ ──── HCM push ────►  ┌──────────────────┐
    │(terminal)│        └─────┬────┘     success           │ HCM_SUBMITTED   │
    └──────────┘              │                            │   (terminal)    │
                         HCM push                          └──────────────────┘
                          fails                                    │
                              ▼                               cancel()
                       ┌────────────┐             [HCM rollback + balance restore]
                       │ HCM_FAILED │                          ▼
                       └────────────┘                   ┌───────────┐
                              │                         │ CANCELLED │
                         cancel() /                     │ (terminal)│
                         retry-hcm                      └───────────┘
                              │
                      ┌───────┴────────┐
                  cancel()          retry()
                 [restore]       [re-attempt HCM]
```

**Key invariants:**
- `PENDING` → deduction in `pendingDeductions`, not yet in `localBalance`
- `APPROVED` → deduction still in `pendingDeductions`, HCM push in progress
- `HCM_SUBMITTED` → deduction moved from `pendingDeductions` to `localBalance` reduction
- `REJECTED` / `CANCELLED` → `pendingDeductions` restored
- `HCM_FAILED` → `pendingDeductions` stays (reflects expected future deduction)

---

## 9. Balance Sync Architecture

### Real-time sync (on every GET /balances)

```
GET /balances/emp/loc
  → load local record
  → fetch HCM balance (3s timeout)
  → if HCM balance ≠ local hcmBalance:
      reconcile: localBalance = hcmBalance = HCM value
      preserve: pendingDeductions unchanged
      audit log the drift
  → return DTO (hcmUnavailable=true if HCM failed)
```

### Webhook sync

```
POST /sync/webhook  { employeeId, locationId, balance }
  → applyBatchSync([{ employeeId, locationId, balance }])
  → localBalance = hcmBalance = webhook.balance
  → pendingDeductions preserved
  → log SyncLog(type=WEBHOOK)
```

### Nightly batch sync

```
@Cron('0 2 * * *')
  → GET /hcm/balances/batch  (full corpus)
  → for each HCM record:
      upsert balance (reconcile or create)
  → retry all HCM_FAILED requests (max 3 attempts each)
  → log SyncLog(type=BATCH, recordsProcessed, updated, created)
```

### Reconciliation invariant

```
localBalance  = hcmBalance_at_last_sync
availableBalance = localBalance − pendingDeductions
```

When HCM changes balance (bonus, refresh):
```
localBalance  ← new_hcm_value
hcmBalance    ← new_hcm_value
pendingDeductions  ← unchanged  ← CRITICAL
```

---

## 10. Alternatives Considered

### Alt A: ExampleHR as pure pass-through (no local balance cache)

Every balance request goes directly to HCM in real time. No local storage for balances.

**Pros:** Always accurate; no sync complexity.

**Cons:** HCM latency on every employee action. HCM unavailability blocks the entire feature. No defence against HCM errors for concurrent requests. Batch endpoint would be unused.

**Verdict: Rejected.** Unacceptable user experience and operational fragility.

---

### Alt B: Event sourcing (balance derived from request history)

Store no `balance` column. Derive available balance by replaying all approved requests from the DB.

**Pros:** Perfect audit trail; no sync drift possible for ExampleHR-originated changes.

**Cons:** Out-of-band HCM changes (anniversary bonuses) have no event in our system — we still need external sync. Replay becomes expensive over time. Adds significant complexity without solving the core problem.

**Verdict: Rejected.** Does not eliminate the HCM sync problem and adds complexity.

---

### Alt C: Distributed lock (Redis/DB advisory lock) for concurrent requests

Use a distributed lock to serialize all balance operations per employee.

**Pros:** Eliminates TOCTOU completely.

**Cons:** Adds Redis infrastructure dependency. Lock contention under load. Deadlock risk. The DB transaction with `pendingDeductions` as an atomic counter already solves this within our single-DB architecture.

**Verdict: Rejected for this scope.** Our `pendingDeductions` counter in a DB transaction provides equivalent correctness without the operational overhead. Revisit if moving to multi-region.

---

### Alt D: HCM as the only balance authority (remove local balance entirely)

Check HCM balance on every request submission; submit deduction synchronously during the API call.

**Pros:** No sync needed; HCM is always the authority.

**Cons:** Ties request submission latency directly to HCM latency. If HCM is slow or down, employees cannot submit requests. No pending state possible — approval would need to be instantaneous. Does not match the described approval workflow.

**Verdict: Rejected.** The approval workflow requires a gap between submission and HCM commitment.

---

### Alt E: Saga/outbox pattern for HCM writes

Persist HCM deduction intent in an outbox table; a separate publisher processes it asynchronously.

**Pros:** Decouples approval latency from HCM latency. Survives HCM downtime gracefully.

**Cons:** Adds infrastructure (outbox processor, message broker or polling loop). Complicates status semantics — the manager approves but the employee doesn't know if HCM committed yet. Longer delay before balance is truly committed.

**Verdict: Deferred.** Our `HCM_FAILED` + retry loop is a simpler approximation of the same idea, adequate for current scale. The outbox pattern is the natural next step if HCM availability becomes a persistent issue.

---

## 11. Error Handling and Defensive Design

### HCM unavailability
- Real-time balance fetch: returns cached data with `hcmUnavailable: true`. Employees see a stale balance but can still interact.
- Approval push: marks request `HCM_FAILED`. Pending deduction preserved. Retried in batch.
- Batch sync failure: logs `SyncStatus.FAILED`, retries next run.

### HCM balance error (INSUFFICIENT_BALANCE, INVALID_DIMENSION)
Even when HCM *should* validate, we defend locally first:
1. Check `availableBalance` before creating a request (pre-approval guard).
2. Apply optimistic deduction atomically in a DB transaction.
3. HCM errors during push land in `HCM_FAILED` for retry or manual resolution.

### Concurrent double-spend
Solved by the `pendingDeductions` counter pattern in a DB transaction. Two concurrent requests both see the same `localBalance − pendingDeductions` at their respective transaction starts; the second will fail if the first already updated `pendingDeductions`.

### Rollback integrity
If HCM rollback fails (e.g. cancellation of an HCM_SUBMITTED request while HCM is down):
- The cancellation still proceeds locally.
- The discrepancy will be corrected by the next batch sync (HCM's balance will override ours).
- Operations are alerted via error log.

### Audit trail
Every balance change and request state transition is written to `audit_logs` with before/after snapshots. This makes every discrepancy diagnosable.

---

## 12. Test Strategy

### Philosophy
Because this service is built with agentic development, tests are the primary quality gate. The test suite is designed to:
1. Catch regressions on every PR.
2. Document the intended behaviour of every edge case.
3. Validate the mock HCM server independently before using it in integration tests.

### Test Layers

#### Layer 1: Unit tests (test/unit/)
- Each service class tested in isolation with all dependencies mocked.
- Fast (< 1s per suite), deterministic, no I/O.
- **Files:** `balance.service.spec.ts`, `request.service.spec.ts`, `sync.service.spec.ts`, `hcm-client.service.spec.ts`

#### Layer 2: Mock HCM server tests (test/unit/hcm-mock-server.spec.ts)
- The mock HCM server is tested independently before being used in integration tests.
- Validates: auth guard, balance CRUD, deduction validation, rollback idempotency, out-of-band mutations.
- This prevents false passes where integration tests succeed only because the mock is too permissive.

#### Layer 3: Integration tests (test/integration/)
- Real NestJS application wired with in-memory sql.js DB and a real Express mock HCM server.
- No external dependencies; fully self-contained.
- **Files:** `request-lifecycle.integration.spec.ts`, `balance-sync.integration.spec.ts`
- Covers: full state machine transitions, balance drift detection, concurrent request guard, webhook sync, batch sync, rollback on cancellation, validation errors, graceful HCM degradation.

### Coverage Results

```
File                         | % Stmts | % Branch | % Lines
-----------------------------|---------|----------|--------
All files                    |   92.64 |    75.22 |   93.12
src/balance/balance.service  |   96.84 |    81.25 |     100
src/hcm/hcm-client.service   |   92.06 |    72.22 |   91.22
src/request/request.service  |   97.05 |    89.28 |   97.91
src/sync/sync.service        |     100 |    66.66 |     100
```

Uncovered branches are primarily: unreachable bootstrap code (`main.ts`, `app.module.ts`), and the `HCM_UNAVAILABLE` outer catch clauses in `hcm-client.service.ts` which require `throwError` to escape the `catchError` pipe — covered by unit tests that mock the Observable directly.

### Test Count Summary

| Suite | Tests |
|-------|-------|
| balance.service.spec | 12 |
| request.service.spec | 20 |
| sync.service.spec | 10 |
| hcm-client.service.spec | 9 |
| hcm-mock-server.spec | 16 |
| request-lifecycle.integration.spec | 14 |
| balance-sync.integration.spec | 8 |
| **Total** | **95** |

---

## 13. Operational Considerations

### Observability
- All service errors are logged with `Logger` using structured context (employeeId, requestId).
- `SyncLog` table provides an operational dashboard queryable via `GET /sync/history`.
- `AuditLog` table records every state transition with before/after for incident investigation.

### HCM_FAILED alerting
Requests stuck in `HCM_FAILED` for more than 3 retries require manual intervention. Recommended: add a scheduled job that alerts on-call if any request has `hcmRetryCount >= 3` and `status = HCM_FAILED`.

### Batch sync schedule
Configurable via `HCM_BATCH_SYNC_CRON` env var (default: `0 2 * * *` — 2 AM daily). For deployments with high HCM-side balance change frequency, consider a more frequent schedule (e.g. every 4 hours).

### Configuration (env vars)
| Variable | Default | Description |
|----------|---------|-------------|
| `HCM_BASE_URL` | `http://localhost:4000` | HCM API base URL |
| `HCM_API_KEY` | — | HCM authentication key |
| `HCM_TIMEOUT_MS` | `5000` | Per-request HCM timeout |
| `HCM_BATCH_SYNC_CRON` | `0 2 * * *` | Batch sync schedule |
| `DB_LOCATION` | `time-off.db` | SQLite file path (omit for in-memory) |
| `PORT` | `3000` | Service listen port |

---

## 14. Open Questions and Future Work

### Scaling beyond single-node
SQLite with sql.js is appropriate for the assessment scope. Production deployments should migrate to PostgreSQL with row-level locking (`SELECT FOR UPDATE`) for the balance deduction transaction. The TypeORM abstraction means this is a one-line driver change plus a migration.

### Outbox pattern for HCM writes
As noted in Alternatives, the `HCM_FAILED` retry loop is a synchronous approximation of the transactional outbox pattern. If HCM availability degrades further, implementing a proper outbox with dead-letter queue support would improve resilience.

### Balance per leave type
The current model stores one balance record per `(employeeId, locationId)`. If HCM provides separate balances per leave type (VACATION: 10, SICK: 5), the `Balance` entity needs an additional `leaveType` dimension and the `availableBalance` check must be scoped accordingly.

### Authentication and RBAC
The service currently trusts caller-supplied `employeeId` and `reviewedBy` fields. A production system needs JWT validation and role enforcement (employees can only submit/cancel their own requests; managers can only review requests in their team).

### Idempotency keys on request creation
To handle network retries on `POST /requests`, add a client-supplied idempotency key (UUID) and deduplicate at the DB layer. This prevents double-submission on transient failures.

### HCM webhook authentication
The `POST /sync/webhook` endpoint currently only validates the payload schema. In production, add HMAC signature verification on the `x-hcm-signature` header to prevent spoofed webhook pushes.
