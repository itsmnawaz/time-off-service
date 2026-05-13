import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { SyncService } from '../../src/sync/sync.service';
import {
  SyncLog,
  SyncStatus,
  SyncType,
} from '../../src/sync/entities/sync-log.entity';
import {
  TimeOffRequest,
  RequestStatus,
} from '../../src/request/entities/time-off-request.entity';
import { AuditLog } from '../../src/common/entities/audit-log.entity';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmClientService, HcmError } from '../../src/hcm/hcm-client.service';
import { RequestService } from '../../src/request/request.service';

function makeMockRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation(async (data: unknown) => ({
      id: 'log-1',
      ...(data as object),
    })),
    ...overrides,
  };
}

describe('SyncService', () => {
  let service: SyncService;
  let syncLogRepo: ReturnType<typeof makeMockRepo>;
  let requestRepo: ReturnType<typeof makeMockRepo>;
  let auditRepo: ReturnType<typeof makeMockRepo>;
  let balanceService: jest.Mocked<BalanceService>;
  let hcmClient: jest.Mocked<HcmClientService>;
  let requestService: jest.Mocked<RequestService>;

  beforeEach(async () => {
    syncLogRepo = makeMockRepo();
    requestRepo = makeMockRepo();
    auditRepo = makeMockRepo();

    balanceService = {
      applyBatchSync: jest.fn().mockResolvedValue({ updated: 2, created: 0 }),
    } as unknown as jest.Mocked<BalanceService>;

    hcmClient = {
      getBatchBalances: jest.fn().mockResolvedValue([
        {
          employeeId: 'emp-1',
          locationId: 'loc-1',
          balance: 10,
          leaveType: 'VACATION',
          effectiveDate: '2026-01-01',
        },
        {
          employeeId: 'emp-2',
          locationId: 'loc-1',
          balance: 5,
          leaveType: 'VACATION',
          effectiveDate: '2026-01-01',
        },
      ]),
    } as unknown as jest.Mocked<HcmClientService>;

    requestService = {
      retryHcmSubmission: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<RequestService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(SyncLog), useValue: syncLogRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmClientService, useValue: hcmClient },
        { provide: RequestService, useValue: requestService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get(SyncService);
  });

  describe('runBatchSync', () => {
    it('fetches HCM batch, applies sync, and returns SUCCESS log', async () => {
      const log = await service.runBatchSync();
      expect(hcmClient.getBatchBalances).toHaveBeenCalledTimes(1);
      expect(balanceService.applyBatchSync).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ employeeId: 'emp-1' }),
          expect.objectContaining({ employeeId: 'emp-2' }),
        ]),
      );
      expect(log.status).toBe(SyncStatus.SUCCESS);
      expect(log.recordsProcessed).toBe(2);
    });

    it('logs FAILED when HCM batch endpoint is unavailable', async () => {
      hcmClient.getBatchBalances.mockRejectedValue(
        new HcmError('Timeout', 'HCM_TIMEOUT'),
      );
      const log = await service.runBatchSync();
      expect(log.status).toBe(SyncStatus.FAILED);
      expect(log.errorMessage).toContain('Timeout');
    });

    it('skips second concurrent run (isBatchRunning guard)', async () => {
      let resolveHcm: (v: unknown) => void = () => {};
      hcmClient.getBatchBalances.mockReturnValueOnce(
        new Promise((r) => {
          resolveHcm = r;
        }),
      );
      const first = service.runBatchSync();
      const secondLog = await service.runBatchSync();
      expect(secondLog.status).toBe(SyncStatus.FAILED);
      expect(secondLog.errorMessage).toContain('Skipped');
      resolveHcm([]);
      await first;
    });

    it('retries HCM_FAILED requests with fewer than 3 attempts', async () => {
      requestRepo.find.mockResolvedValue([
        { id: 'req-1', status: RequestStatus.HCM_FAILED, hcmRetryCount: 1 },
        { id: 'req-2', status: RequestStatus.HCM_FAILED, hcmRetryCount: 2 },
      ]);
      await service.runBatchSync();
      expect(requestService.retryHcmSubmission).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry requests that have already failed 3 times', async () => {
      requestRepo.find.mockResolvedValue([
        { id: 'req-1', status: RequestStatus.HCM_FAILED, hcmRetryCount: 3 },
      ]);
      await service.runBatchSync();
      expect(requestService.retryHcmSubmission).not.toHaveBeenCalled();
    });

    it('continues batch even when individual retry fails', async () => {
      requestRepo.find.mockResolvedValue([
        { id: 'req-1', status: RequestStatus.HCM_FAILED, hcmRetryCount: 0 },
        { id: 'req-2', status: RequestStatus.HCM_FAILED, hcmRetryCount: 0 },
      ]);
      requestService.retryHcmSubmission
        .mockRejectedValueOnce(new Error('Still failing'))
        .mockResolvedValueOnce({} as any);
      const log = await service.runBatchSync();
      expect(log.status).toBe(SyncStatus.SUCCESS);
    });

    it('writes BATCH_SYNC_STARTED and BATCH_SYNC_COMPLETED audit logs', async () => {
      await service.runBatchSync();
      const savedActions = auditRepo.save.mock.calls.map(
        ([a]: [{ action: string }]) => a.action,
      );
      expect(savedActions).toContain('BATCH_SYNC_STARTED');
      expect(savedActions).toContain('BATCH_SYNC_COMPLETED');
    });
  });

  describe('handleWebhookUpdate', () => {
    it('applies single-record sync and returns SUCCESS log', async () => {
      const log = await service.handleWebhookUpdate('emp-1', 'loc-1', 15);
      expect(balanceService.applyBatchSync).toHaveBeenCalledWith([
        { employeeId: 'emp-1', locationId: 'loc-1', balance: 15 },
      ]);
      expect(log.status).toBe(SyncStatus.SUCCESS);
      expect(log.syncType).toBe(SyncType.WEBHOOK);
    });

    it('returns FAILED log when applyBatchSync throws', async () => {
      balanceService.applyBatchSync.mockRejectedValue(new Error('DB error'));
      const log = await service.handleWebhookUpdate('emp-1', 'loc-1', 15);
      expect(log.status).toBe(SyncStatus.FAILED);
      expect(log.errorMessage).toContain('DB error');
    });
  });

  describe('getSyncHistory', () => {
    it('returns logs ordered by createdAt DESC with requested limit', async () => {
      syncLogRepo.find.mockResolvedValue([{ id: 'log-1' }]);
      const result = await service.getSyncHistory(10);
      expect(syncLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'DESC' }, take: 10 }),
      );
      expect(result).toHaveLength(1);
    });
  });
});
