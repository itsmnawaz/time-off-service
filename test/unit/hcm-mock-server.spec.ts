/**
 * Tests for the mock HCM server itself.
 *
 * The mock server is a critical piece of the test infrastructure.
 * Validating it independently ensures that integration test failures
 * reflect real application bugs, not mock bugs.
 */
import * as http from 'http';
import { createMockHcmApp } from '../mocks/hcm-server/hcm-mock.server';

const API_KEY = 'hcm-api-key';

async function doFetch(
  port: number,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      ...(options.headers ?? {}),
    },
  });
}

describe('Mock HCM Server', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    port = 16000;
    const app = createMockHcmApp();
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    await doFetch(port, '/admin/reset', { method: 'POST' });
  });

  // ── Auth ───────────────────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('returns 401 without API key', async () => {
      const res = await fetch(
        `http://localhost:${port}/hcm/balances/emp-1/loc-1`,
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong API key', async () => {
      const res = await fetch(
        `http://localhost:${port}/hcm/balances/emp-1/loc-1`,
        {
          headers: { 'x-api-key': 'wrong-key' },
        },
      );
      expect(res.status).toBe(401);
    });
  });

  // ── Balance read ───────────────────────────────────────────────────────────

  describe('GET /hcm/balances/:employeeId/:locationId', () => {
    it('returns 404 for unknown employee+location', async () => {
      const res = await doFetch(port, '/hcm/balances/emp-x/loc-x');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('EMPLOYEE_LOCATION_NOT_FOUND');
    });

    it('returns balance after seeding', async () => {
      await doFetch(port, '/admin/seed', {
        method: 'POST',
        body: JSON.stringify([
          { employeeId: 'emp-1', locationId: 'loc-1', balance: 10 },
        ]),
      });

      const res = await doFetch(port, '/hcm/balances/emp-1/loc-1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { balance: number };
      expect(body.balance).toBe(10);
    });
  });

  // ── Batch balance ──────────────────────────────────────────────────────────

  describe('GET /hcm/balances/batch', () => {
    it('returns empty array when no records seeded', async () => {
      const res = await doFetch(port, '/hcm/balances/batch');
      const body = (await res.json()) as unknown[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(0);
    });

    it('returns all seeded records', async () => {
      await doFetch(port, '/admin/seed', {
        method: 'POST',
        body: JSON.stringify([
          { employeeId: 'emp-1', locationId: 'loc-1', balance: 10 },
          { employeeId: 'emp-2', locationId: 'loc-2', balance: 5 },
        ]),
      });

      const res = await doFetch(port, '/hcm/balances/batch');
      const body = (await res.json()) as unknown[];
      expect(body).toHaveLength(2);
    });
  });

  // ── Deductions ─────────────────────────────────────────────────────────────

  describe('POST /hcm/deductions', () => {
    beforeEach(async () => {
      await doFetch(port, '/admin/seed', {
        method: 'POST',
        body: JSON.stringify([
          {
            employeeId: 'emp-1',
            locationId: 'loc-1',
            balance: 10,
            leaveType: 'VACATION',
          },
        ]),
      });
    });

    it('deducts balance and returns transaction ID', async () => {
      const res = await doFetch(port, '/hcm/deductions', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'VACATION',
          days: 3,
          startDate: '2026-06-01',
          endDate: '2026-06-03',
          transactionRef: 'req-1',
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        success: boolean;
        transactionId: string;
        remainingBalance: number;
      };
      expect(body.success).toBe(true);
      expect(body.transactionId).toBeDefined();
      expect(body.remainingBalance).toBe(7);
    });

    it('returns 422 INSUFFICIENT_BALANCE when requesting more than available', async () => {
      const res = await doFetch(port, '/hcm/deductions', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'VACATION',
          days: 15,
          startDate: '2026-06-01',
          endDate: '2026-06-15',
          transactionRef: 'req-2',
        }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('returns 422 INVALID_LEAVE_TYPE for unknown leave type', async () => {
      const res = await doFetch(port, '/hcm/deductions', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'FANTASY_LEAVE',
          days: 1,
          startDate: '2026-06-01',
          endDate: '2026-06-01',
          transactionRef: 'req-3',
        }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('INVALID_LEAVE_TYPE');
    });

    it('returns 422 INVALID_DIMENSION for unknown employee+location', async () => {
      const res = await doFetch(port, '/hcm/deductions', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-x',
          locationId: 'loc-x',
          leaveType: 'VACATION',
          days: 1,
          startDate: '2026-06-01',
          endDate: '2026-06-01',
          transactionRef: 'req-4',
        }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('INVALID_DIMENSION');
    });

    it('correctly tracks remaining balance across multiple deductions', async () => {
      await doFetch(port, '/hcm/deductions', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'VACATION',
          days: 2,
          startDate: '2026-06-01',
          endDate: '2026-06-02',
          transactionRef: 'req-a',
        }),
      });

      const res2 = await doFetch(port, '/hcm/deductions', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'VACATION',
          days: 3,
          startDate: '2026-07-01',
          endDate: '2026-07-03',
          transactionRef: 'req-b',
        }),
      });

      const body = (await res2.json()) as { remainingBalance: number };
      expect(body.remainingBalance).toBe(5); // 10 - 2 - 3
    });
  });

  // ── Rollbacks ──────────────────────────────────────────────────────────────

  describe('POST /hcm/deductions/:id/rollback', () => {
    it('restores balance on rollback', async () => {
      await doFetch(port, '/admin/seed', {
        method: 'POST',
        body: JSON.stringify([
          {
            employeeId: 'emp-1',
            locationId: 'loc-1',
            balance: 10,
            leaveType: 'VACATION',
          },
        ]),
      });

      const dedRes = await doFetch(port, '/hcm/deductions', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'VACATION',
          days: 4,
          startDate: '2026-06-01',
          endDate: '2026-06-04',
          transactionRef: 'req-1',
        }),
      });
      const { transactionId } = (await dedRes.json()) as {
        transactionId: string;
      };

      const rollbackRes = await doFetch(
        port,
        `/hcm/deductions/${transactionId}/rollback`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: 'Cancellation' }),
        },
      );
      expect(rollbackRes.status).toBe(200);

      // Check balance restored
      const balRes = await doFetch(port, '/hcm/balances/emp-1/loc-1');
      const bal = (await balRes.json()) as { balance: number };
      expect(bal.balance).toBe(10);
    });

    it('returns 409 when rolling back an already rolled-back transaction', async () => {
      await doFetch(port, '/admin/seed', {
        method: 'POST',
        body: JSON.stringify([
          {
            employeeId: 'emp-1',
            locationId: 'loc-1',
            balance: 10,
            leaveType: 'VACATION',
          },
        ]),
      });

      const dedRes = await doFetch(port, '/hcm/deductions', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'VACATION',
          days: 2,
          startDate: '2026-06-01',
          endDate: '2026-06-02',
          transactionRef: 'req-1',
        }),
      });
      const { transactionId } = (await dedRes.json()) as {
        transactionId: string;
      };

      await doFetch(port, `/hcm/deductions/${transactionId}/rollback`, {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const res2 = await doFetch(
        port,
        `/hcm/deductions/${transactionId}/rollback`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      expect(res2.status).toBe(409);
    });

    it('returns 404 for unknown transaction ID', async () => {
      const res = await doFetch(
        port,
        '/hcm/deductions/nonexistent-tx/rollback',
        { method: 'POST', body: JSON.stringify({}) },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── Out-of-band mutations ──────────────────────────────────────────────────

  describe('POST /admin/mutate-balance (out-of-band HCM changes)', () => {
    it('updates balance without a transaction record', async () => {
      await doFetch(port, '/admin/seed', {
        method: 'POST',
        body: JSON.stringify([
          { employeeId: 'emp-1', locationId: 'loc-1', balance: 10 },
        ]),
      });

      await doFetch(port, '/admin/mutate-balance', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          newBalance: 20,
        }),
      });

      const balRes = await doFetch(port, '/hcm/balances/emp-1/loc-1');
      const bal = (await balRes.json()) as { balance: number };
      expect(bal.balance).toBe(20);
    });

    it('returns 404 for unknown employee+location', async () => {
      const res = await doFetch(port, '/admin/mutate-balance', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: 'emp-x',
          locationId: 'loc-x',
          newBalance: 5,
        }),
      });
      expect(res.status).toBe(404);
    });
  });
});
