/**
 * Mock HCM Server
 *
 * Simulates a real Human Capital Management system with:
 * - Real-time balance GET endpoint
 * - Deduction POST endpoint (validates balance, rejects bad dimensions)
 * - Rollback endpoint
 * - Batch balance GET endpoint
 * - Out-of-band balance mutation endpoint (simulates anniversary bonuses)
 *
 * State is in-memory. Seed via POST /admin/seed.
 */
import express, { Request, Response, NextFunction } from 'express';

export interface HcmBalanceRecord {
  employeeId: string;
  locationId: string;
  balance: number;
  leaveType: string;
  effectiveDate: string;
}

export interface HcmTransaction {
  transactionId: string;
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  startDate: string;
  endDate: string;
  transactionRef: string;
  status: 'committed' | 'rolled_back';
  createdAt: string;
}

// In-memory store
const balances = new Map<string, HcmBalanceRecord>();
const transactions = new Map<string, HcmTransaction>();

function balanceKey(employeeId: string, locationId: string): string {
  return `${employeeId}::${locationId}`;
}

export function createMockHcmApp() {
  const app = express();
  app.use(express.json());

  // API key guard
  app.use((req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== 'hcm-api-key') {
      res
        .status(401)
        .json({ code: 'UNAUTHORIZED', message: 'Invalid API key' });
      return;
    }
    next();
  });

  // ── Admin / test-control endpoints ────────────────────────────────────────

  /**
   * Seed or overwrite balances for testing.
   * POST /admin/seed
   * Body: [{ employeeId, locationId, balance, leaveType? }]
   */
  app.post('/admin/seed', (req: Request, res: Response) => {
    const records: Partial<HcmBalanceRecord>[] = Array.isArray(req.body)
      ? req.body
      : [req.body];

    for (const r of records) {
      if (!r.employeeId || !r.locationId || r.balance === undefined) {
        res
          .status(400)
          .json({ code: 'BAD_REQUEST', message: 'Missing required fields' });
        return;
      }
      const key = balanceKey(r.employeeId, r.locationId);
      balances.set(key, {
        employeeId: r.employeeId,
        locationId: r.locationId,
        balance: r.balance,
        leaveType: r.leaveType ?? 'VACATION',
        effectiveDate: new Date().toISOString().slice(0, 10),
      });
    }

    res.json({ seeded: records.length });
  });

  /**
   * Out-of-band balance mutation — simulates anniversary bonus, year reset, etc.
   * POST /admin/mutate-balance
   * Body: { employeeId, locationId, newBalance }
   */
  app.post('/admin/mutate-balance', (req: Request, res: Response) => {
    const { employeeId, locationId, newBalance } = req.body;
    const key = balanceKey(employeeId, locationId);
    const existing = balances.get(key);
    if (!existing) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Balance not found' });
      return;
    }
    existing.balance = newBalance;
    existing.effectiveDate = new Date().toISOString().slice(0, 10);
    res.json({ employeeId, locationId, newBalance });
  });

  /**
   * Reset all state (for test isolation).
   * POST /admin/reset
   */
  app.post('/admin/reset', (_req: Request, res: Response) => {
    balances.clear();
    transactions.clear();
    res.json({ message: 'State reset' });
  });

  /**
   * Inspect internal state (for test assertions).
   * GET /admin/state
   */
  app.get('/admin/state', (_req: Request, res: Response) => {
    res.json({
      balances: Object.fromEntries(balances),
      transactions: Object.fromEntries(transactions),
    });
  });

  // ── HCM API endpoints ──────────────────────────────────────────────────────

  /**
   * Real-time balance read.
   * GET /hcm/balances/:employeeId/:locationId
   */
  app.get(
    '/hcm/balances/:employeeId/:locationId',
    (req: Request, res: Response) => {
      const employeeId = req.params['employeeId'] as string;
      const locationId = req.params['locationId'] as string;
      const key = balanceKey(employeeId, locationId);
      const record = balances.get(key);

      if (!record) {
        res.status(404).json({
          code: 'EMPLOYEE_LOCATION_NOT_FOUND',
          message: `No balance for employee=${employeeId} location=${locationId}`,
        });
        return;
      }

      res.json(record);
    },
  );

  /**
   * Batch balance export — returns all known balances.
   * GET /hcm/balances/batch
   */
  app.get('/hcm/balances/batch', (_req: Request, res: Response) => {
    res.json(Array.from(balances.values()));
  });

  /**
   * Submit a deduction against HCM.
   * POST /hcm/deductions
   *
   * HCM validates:
   *  - Employee+location must exist
   *  - Sufficient balance
   *  - leaveType must be a known value
   *
   * Returns the transaction ID and remaining balance.
   */
  app.post('/hcm/deductions', (req: Request, res: Response) => {
    const {
      employeeId,
      locationId,
      leaveType,
      days,
      startDate,
      endDate,
      transactionRef,
    } = req.body;

    // Validate dimensions
    const validLeaveTypes = [
      'VACATION',
      'SICK',
      'PERSONAL',
      'BEREAVEMENT',
      'OTHER',
    ];
    if (!validLeaveTypes.includes(leaveType)) {
      res.status(422).json({
        code: 'INVALID_LEAVE_TYPE',
        message: `Unknown leaveType: ${leaveType}`,
      });
      return;
    }

    const key = balanceKey(employeeId, locationId);
    const record = balances.get(key);

    if (!record) {
      res.status(422).json({
        code: 'INVALID_DIMENSION',
        message: `No HCM record for employee=${employeeId} location=${locationId}`,
      });
      return;
    }

    if (record.balance < days) {
      res.status(422).json({
        code: 'INSUFFICIENT_BALANCE',
        message: `HCM balance ${record.balance} < requested ${days}`,
      });
      return;
    }

    record.balance = parseFloat((record.balance - days).toFixed(4));
    record.effectiveDate = new Date().toISOString().slice(0, 10);

    const transactionId = require('crypto').randomUUID();
    const tx: HcmTransaction = {
      transactionId,
      employeeId,
      locationId,
      leaveType,
      days,
      startDate,
      endDate,
      transactionRef,
      status: 'committed',
      createdAt: new Date().toISOString(),
    };
    transactions.set(transactionId, tx);

    res.status(201).json({
      success: true,
      transactionId,
      remainingBalance: record.balance,
    });
  });

  /**
   * Rollback a previously committed deduction.
   * POST /hcm/deductions/:transactionId/rollback
   */
  app.post(
    '/hcm/deductions/:transactionId/rollback',
    (req: Request, res: Response) => {
      const transactionId = req.params['transactionId'] as string;
      const tx = transactions.get(transactionId);

      if (!tx) {
        res.status(404).json({
          code: 'TRANSACTION_NOT_FOUND',
          message: `Transaction ${transactionId} not found`,
        });
        return;
      }

      if (tx.status === 'rolled_back') {
        res.status(409).json({
          code: 'ALREADY_ROLLED_BACK',
          message: `Transaction ${transactionId} already rolled back`,
        });
        return;
      }

      const key = balanceKey(tx.employeeId, tx.locationId);
      const record = balances.get(key);

      if (record) {
        record.balance = parseFloat((record.balance + tx.days).toFixed(4));
        record.effectiveDate = new Date().toISOString().slice(0, 10);
      }

      tx.status = 'rolled_back';

      res.json({ success: true, transactionId, restoredDays: tx.days });
    },
  );

  return app;
}

// ── Standalone server entry ────────────────────────────────────────────────

if (require.main === module) {
  const PORT = parseInt(process.env.HCM_MOCK_PORT ?? '4000', 10);
  const app = createMockHcmApp();
  app.listen(PORT, () => {
    console.log(`Mock HCM server running on port ${PORT}`);
  });
}
