# Time-Off Microservice

A NestJS microservice managing employee time-off request lifecycle and balance synchronisation with an HCM (Human Capital Management) system.

## Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** NestJS
- **Database:** SQLite via `sql.js` (pure JS, no native bindings)
- **ORM:** TypeORM (sqljs driver)
- **Testing:** Jest + Supertest + real in-process mock HCM server

## Quick Start

```bash
npm install
npm run start:dev
```

Service listens on `http://localhost:3000`.

## Running the Mock HCM Server (standalone)

```bash
npx ts-node test/mocks/hcm-server/hcm-mock.server.ts
# Starts on port 4000
```

## Running Tests

```bash
# All tests with coverage (serial — required for integration tests)
npm run test:cov

# Unit tests only
npm run test:unit

# Integration tests only  
npm run test:integration
```

### Test Results

```
Test Suites: 7 passed, 7 total
Tests:       95 passed, 95 total

Coverage:
  Statements : 92.64%
  Branches   : 75.22%
  Functions  : 95.58%
  Lines      : 93.12%
```

## API Reference

### Balance
```
GET  /balances/:employeeId/:locationId
POST /balances/upsert
```

### Requests
```
GET    /requests
GET    /requests/:id
POST   /requests
PATCH  /requests/:id/review
DELETE /requests/:id
POST   /requests/:id/retry-hcm
```

### Sync
```
POST /sync/webhook
POST /sync/manual
GET  /sync/history
```

## Design Document
See [TRD.md](./TRD.md) for the full Technical Requirements Document.
