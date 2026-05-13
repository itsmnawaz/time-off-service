/**
 * Integration tests: balance sync scenarios
 *
 * Covers the trickiest part of the system: keeping balances in sync
 * between ExampleHR and HCM when either side can change independently.
 */
import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import {
  createIntegrationApp,
  teardownIntegrationApp,
  hcmSeed,
  hcmMutate,
  hcmGetState,
  hcmReset,
  IntegrationContext,
} from './integration-app.factory';
import {
  RequestStatus,
  LeaveType,
} from '../../src/request/entities/time-off-request.entity';
import { SyncStatus } from '../../src/sync/entities/sync-log.entity';

describe('Balance Sync Integration', () => {
  let ctx: IntegrationContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await teardownIntegrationApp(ctx);
  });

  beforeEach(async () => {
    await hcmReset(ctx.hcmPort);
  });

  // ── Batch sync ─────────────────────────────────────────────────────────────

  describe('Manual batch sync', () => {
    it('creates new local records for employees only in HCM', async () => {
      await hcmSeed(ctx.hcmPort, [
        { employeeId: 'sync-emp-1', locationId: 'loc-A', balance: 12 },
        { employeeId: 'sync-emp-2', locationId: 'loc-A', balance: 8 },
        { employeeId: 'sync-emp-3', locationId: 'loc-B', balance: 15 },
      ]);

      // Trigger manual sync
      await supertest(app.getHttpServer()).post('/sync/manual').expect(202);

      // Give async sync a moment to complete
      await new Promise((r) => setTimeout(r, 200));

      // All three employees should now have local balances
      const b1 = await supertest(app.getHttpServer())
        .get('/balances/sync-emp-1/loc-A')
        .expect(200);
      const b2 = await supertest(app.getHttpServer())
        .get('/balances/sync-emp-2/loc-A')
        .expect(200);
      const b3 = await supertest(app.getHttpServer())
        .get('/balances/sync-emp-3/loc-B')
        .expect(200);

      expect(b1.body.localBalance).toBe(12);
      expect(b2.body.localBalance).toBe(8);
      expect(b3.body.localBalance).toBe(15);
    });

    it('updates local balance when HCM has a higher value (e.g. year-start refresh)', async () => {
      await hcmSeed(ctx.hcmPort, [
        { employeeId: 'sync-emp-4', locationId: 'loc-A', balance: 10 },
      ]);

      // Initialize locally
      await supertest(app.getHttpServer())
        .get('/balances/sync-emp-4/loc-A')
        .expect(200);

      // HCM refreshes balance at year start
      await hcmMutate(ctx.hcmPort, 'sync-emp-4', 'loc-A', 20);

      // Trigger batch sync
      await supertest(app.getHttpServer()).post('/sync/manual').expect(202);
      await new Promise((r) => setTimeout(r, 200));

      const b = await supertest(app.getHttpServer())
        .get('/balances/sync-emp-4/loc-A')
        .expect(200);
      expect(b.body.localBalance).toBe(20);
    });
  });

  // ── Webhook sync ───────────────────────────────────────────────────────────

  describe('Webhook-driven balance updates', () => {
    it('immediately reflects HCM push for anniversary bonus', async () => {
      await hcmSeed(ctx.hcmPort, [
        { employeeId: 'wh-emp-1', locationId: 'loc-A', balance: 10 },
      ]);

      // Initialize local record
      await supertest(app.getHttpServer())
        .get('/balances/wh-emp-1/loc-A')
        .expect(200);

      // HCM applies anniversary bonus (+5 days) to its own state first
      await hcmMutate(ctx.hcmPort, 'wh-emp-1', 'loc-A', 15);

      // HCM then pushes webhook notification to ExampleHR
      const webhookRes = await supertest(app.getHttpServer())
        .post('/sync/webhook')
        .send({ employeeId: 'wh-emp-1', locationId: 'loc-A', balance: 15 })
        .expect(200);

      expect(webhookRes.body.status).toBe(SyncStatus.SUCCESS);
      expect(webhookRes.body.recordsUpdated).toBe(1);

      // GET also does a live HCM fetch; HCM now reports 15, so no re-reconciliation
      const b = await supertest(app.getHttpServer())
        .get('/balances/wh-emp-1/loc-A')
        .expect(200);
      expect(b.body.localBalance).toBe(15);
      expect(b.body.hcmBalance).toBe(15);
    });

    it('preserves pending deductions when webhook increases balance', async () => {
      await hcmSeed(ctx.hcmPort, [
        {
          employeeId: 'wh-emp-2',
          locationId: 'loc-A',
          balance: 10,
          leaveType: 'VACATION',
        },
      ]);

      // Employee submits a request (creates pending deduction of 3 days)
      await supertest(app.getHttpServer())
        .post('/requests')
        .send({
          employeeId: 'wh-emp-2',
          locationId: 'loc-A',
          leaveType: LeaveType.VACATION,
          daysRequested: 3,
          startDate: '2026-06-01',
          endDate: '2026-06-03',
        })
        .expect(201);

      // HCM applies anniversary bonus (+5 days) to its own state first, then notifies
      await hcmMutate(ctx.hcmPort, 'wh-emp-2', 'loc-A', 15);

      // HCM sends anniversary bonus webhook (+5)
      await supertest(app.getHttpServer())
        .post('/sync/webhook')
        .send({ employeeId: 'wh-emp-2', locationId: 'loc-A', balance: 15 })
        .expect(200);

      const b = await supertest(app.getHttpServer())
        .get('/balances/wh-emp-2/loc-A')
        .expect(200);

      // localBalance updated to 15, pendingDeductions preserved at 3
      expect(b.body.localBalance).toBe(15);
      expect(b.body.pendingDeductions).toBe(3);
      expect(b.body.availableBalance).toBe(12); // 15 - 3
    });

    it('records a WEBHOOK type sync log', async () => {
      await hcmSeed(ctx.hcmPort, [
        { employeeId: 'wh-emp-3', locationId: 'loc-A', balance: 5 },
      ]);

      await supertest(app.getHttpServer())
        .post('/sync/webhook')
        .send({ employeeId: 'wh-emp-3', locationId: 'loc-A', balance: 8 })
        .expect(200);

      const history = await supertest(app.getHttpServer())
        .get('/sync/history?limit=20')
        .expect(200);

      // Find the webhook log for wh-emp-3 specifically (other tests may have created WEBHOOK logs too)
      const webhookLog = history.body.find(
        (l: { syncType: string; employeeId: string }) =>
          l.syncType === 'WEBHOOK' && l.employeeId === 'wh-emp-3',
      );
      expect(webhookLog).toBeDefined();
      expect(webhookLog.employeeId).toBe('wh-emp-3');
    });
  });

  // ── Sync history ───────────────────────────────────────────────────────────

  describe('Sync history endpoint', () => {
    it('returns sync logs in reverse chronological order', async () => {
      await hcmSeed(ctx.hcmPort, [
        { employeeId: 'hist-emp-1', locationId: 'loc-A', balance: 5 },
      ]);

      // Create two webhook events
      await supertest(app.getHttpServer())
        .post('/sync/webhook')
        .send({ employeeId: 'hist-emp-1', locationId: 'loc-A', balance: 6 });
      await supertest(app.getHttpServer())
        .post('/sync/webhook')
        .send({ employeeId: 'hist-emp-1', locationId: 'loc-A', balance: 7 });

      const history = await supertest(app.getHttpServer())
        .get('/sync/history?limit=10')
        .expect(200);

      expect(Array.isArray(history.body)).toBe(true);
      // Most recent first
      if (history.body.length >= 2) {
        const dates = history.body.map((l: { createdAt: string }) =>
          new Date(l.createdAt).getTime(),
        );
        expect(dates[0]).toBeGreaterThanOrEqual(dates[1]);
      }
    });
  });

  // ── Admin upsert balance ───────────────────────────────────────────────────

  describe('Admin balance upsert', () => {
    it('creates a balance record via the upsert endpoint', async () => {
      const res = await supertest(app.getHttpServer())
        .post('/balances/upsert')
        .send({ employeeId: 'admin-emp-1', locationId: 'loc-X', balance: 25 })
        .expect(200);

      expect(res.body.localBalance).toBe(25);
    });
  });

  // ── Defensive: HCM balance discrepancy ────────────────────────────────────

  describe('Defensive: HCM reports different balance than ExampleHR expected', () => {
    it('marks hcmUnavailable=true and returns cached data when HCM is down', async () => {
      // Seed and initialize
      await hcmSeed(ctx.hcmPort, [
        { employeeId: 'def-emp-1', locationId: 'loc-A', balance: 10 },
      ]);
      await supertest(app.getHttpServer())
        .get('/balances/def-emp-1/loc-A')
        .expect(200);

      // Tear down HCM server connection temporarily by calling a non-existent port
      // We simulate this by stopping the HCM server briefly
      await new Promise<void>((resolve) =>
        ctx.hcmServer.close(() => resolve()),
      );

      const res = await supertest(app.getHttpServer())
        .get('/balances/def-emp-1/loc-A')
        .expect(200);

      expect(res.body.hcmUnavailable).toBe(true);
      // Still returns cached data
      expect(res.body.localBalance).toBeDefined();

      // Restart HCM server for remaining tests
      await new Promise<void>((resolve) => {
        const hcmExpressApp =
          require('../mocks/hcm-server/hcm-mock.server').createMockHcmApp();
        ctx.hcmServer = hcmExpressApp.listen(ctx.hcmPort, () => resolve());
      });
    });
  });
});
