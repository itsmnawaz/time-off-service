import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { BalanceService } from '../../src/balance/balance.service';
import { Balance } from '../../src/balance/entities/balance.entity';
import {
  AuditLog,
  AuditAction,
} from '../../src/common/entities/audit-log.entity';
import { HcmClientService, HcmError } from '../../src/hcm/hcm-client.service';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBalance(overrides: Partial<Balance> = {}): Balance {
  return {
    id: 'bal-1',
    employeeId: 'emp-1',
    locationId: 'loc-1',
    localBalance: 10,
    hcmBalance: 10,
    pendingDeductions: 0,
    version: 0,
    lastHcmSyncAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockRepo<T>(
  overrides: Partial<Record<keyof Repository<T>, jest.Mock>> = {},
) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
    create: jest.fn(),
    ...overrides,
  };
}

function makeMockDataSource(savedBalance: Balance) {
  return {
    transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => {
      const manager = {
        findOne: jest.fn().mockResolvedValue(savedBalance),
        save: jest
          .fn()
          .mockImplementation(async (_Entity: unknown, data: Balance) => ({
            ...savedBalance,
            ...data,
          })),
      };
      return cb(manager);
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BalanceService', () => {
  let service: BalanceService;
  let balanceRepo: ReturnType<typeof makeMockRepo<Balance>>;
  let auditRepo: ReturnType<typeof makeMockRepo<AuditLog>>;
  let hcmClient: jest.Mocked<HcmClientService>;

  const balance = makeBalance();

  beforeEach(async () => {
    balanceRepo = makeMockRepo<Balance>();
    auditRepo = makeMockRepo<AuditLog>();

    hcmClient = {
      getBalance: jest.fn(),
      submitDeduction: jest.fn(),
      rollbackDeduction: jest.fn(),
      getBatchBalances: jest.fn(),
    } as unknown as jest.Mocked<HcmClientService>;

    const dataSource = makeMockDataSource(balance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(Balance), useValue: balanceRepo },
        { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
        { provide: HcmClientService, useValue: hcmClient },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(BalanceService);
  });

  // ── getBalance ─────────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('returns the balance when HCM agrees', async () => {
      balanceRepo.findOne.mockResolvedValue(balance);
      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        balance: 10,
        leaveType: 'VACATION',
        effectiveDate: '2026-01-01',
      });

      const result = await service.getBalance('emp-1', 'loc-1');

      expect(result.localBalance).toBe(10);
      expect(result.availableBalance).toBe(10);
      expect(result.hcmUnavailable).toBe(false);
    });

    it('reconciles when HCM balance drifts (e.g. anniversary bonus)', async () => {
      const localBalance = makeBalance({ localBalance: 10, hcmBalance: 10 });
      balanceRepo.findOne.mockResolvedValue(localBalance);
      balanceRepo.save.mockImplementation(async (b: Balance) => b);
      auditRepo.save.mockResolvedValue({});

      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        balance: 15, // HCM added 5 days via anniversary bonus
        leaveType: 'VACATION',
        effectiveDate: '2026-01-01',
      });

      const result = await service.getBalance('emp-1', 'loc-1');

      expect(result.localBalance).toBe(15);
      expect(result.hcmBalance).toBe(15);
      expect(balanceRepo.save).toHaveBeenCalled();
      expect(auditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.BALANCE_SYNCED }),
      );
    });

    it('returns cached balance with hcmUnavailable=true when HCM is down', async () => {
      balanceRepo.findOne.mockResolvedValue(balance);
      hcmClient.getBalance.mockRejectedValue(
        new HcmError('Connection refused', 'HCM_UNAVAILABLE'),
      );

      const result = await service.getBalance('emp-1', 'loc-1');

      expect(result.hcmUnavailable).toBe(true);
      expect(result.localBalance).toBe(10);
    });

    it('initializes a zero balance when employee has no existing record', async () => {
      balanceRepo.findOne.mockResolvedValue(null);
      balanceRepo.save.mockImplementation(async (data: Partial<Balance>) => ({
        ...data,
        id: 'new-bal',
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      hcmClient.getBalance.mockRejectedValue(
        new HcmError('Not found', 'HCM_NOT_FOUND'),
      );

      const result = await service.getBalance('emp-new', 'loc-1');

      expect(result.localBalance).toBe(0);
      expect(result.availableBalance).toBe(0);
    });
  });

  // ── applyLocalDeduction ────────────────────────────────────────────────────

  describe('applyLocalDeduction', () => {
    it('increases pendingDeductions by the requested days', async () => {
      const bal = makeBalance({ localBalance: 10, pendingDeductions: 0 });

      const dataSource = {
        transaction: jest.fn(async (cb: Function) => {
          const manager = {
            findOne: jest.fn().mockResolvedValue(bal),
            save: jest
              .fn()
              .mockImplementation(async (_: unknown, data: Balance) => ({
                ...bal,
                ...data,
              })),
          };
          return cb(manager);
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BalanceService,
          { provide: getRepositoryToken(Balance), useValue: balanceRepo },
          { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
          { provide: HcmClientService, useValue: hcmClient },
          { provide: DataSource, useValue: dataSource },
        ],
      }).compile();

      const svc = module.get(BalanceService);
      const result = await svc.applyLocalDeduction(
        'emp-1',
        'loc-1',
        3,
        'req-1',
      );

      expect(result.pendingDeductions).toBe(3);
    });

    it('throws ConflictException when balance is insufficient', async () => {
      const bal = makeBalance({ localBalance: 2, pendingDeductions: 0 });

      const dataSource = {
        transaction: jest.fn(async (cb: Function) => {
          const manager = {
            findOne: jest.fn().mockResolvedValue(bal),
            save: jest.fn(),
          };
          return cb(manager);
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BalanceService,
          { provide: getRepositoryToken(Balance), useValue: balanceRepo },
          { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
          { provide: HcmClientService, useValue: hcmClient },
          { provide: DataSource, useValue: dataSource },
        ],
      }).compile();

      const svc = module.get(BalanceService);
      await expect(
        svc.applyLocalDeduction('emp-1', 'loc-1', 5, 'req-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when balance record does not exist', async () => {
      const dataSource = {
        transaction: jest.fn(async (cb: Function) => {
          const manager = {
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn(),
          };
          return cb(manager);
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BalanceService,
          { provide: getRepositoryToken(Balance), useValue: balanceRepo },
          { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
          { provide: HcmClientService, useValue: hcmClient },
          { provide: DataSource, useValue: dataSource },
        ],
      }).compile();

      const svc = module.get(BalanceService);
      await expect(
        svc.applyLocalDeduction('emp-x', 'loc-x', 1, 'req-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('respects existing pendingDeductions in available balance calculation', async () => {
      // 10 total, 7 already pending → only 3 available
      const bal = makeBalance({ localBalance: 10, pendingDeductions: 7 });

      const dataSource = {
        transaction: jest.fn(async (cb: Function) => {
          const manager = {
            findOne: jest.fn().mockResolvedValue(bal),
            save: jest
              .fn()
              .mockImplementation(async (_: unknown, data: Balance) => ({
                ...bal,
                ...data,
              })),
          };
          return cb(manager);
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BalanceService,
          { provide: getRepositoryToken(Balance), useValue: balanceRepo },
          { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
          { provide: HcmClientService, useValue: hcmClient },
          { provide: DataSource, useValue: dataSource },
        ],
      }).compile();

      const svc = module.get(BalanceService);

      // Requesting 4 when only 3 available → should fail
      await expect(
        svc.applyLocalDeduction('emp-1', 'loc-1', 4, 'req-1'),
      ).rejects.toThrow(ConflictException);

      // Requesting 3 when 3 available → should succeed
      const result = await svc.applyLocalDeduction(
        'emp-1',
        'loc-1',
        3,
        'req-1',
      );
      expect(result.pendingDeductions).toBe(10);
    });
  });

  // ── commitDeduction ────────────────────────────────────────────────────────

  describe('commitDeduction', () => {
    it('reduces localBalance and hcmBalance, clears pendingDeductions', async () => {
      const bal = makeBalance({
        localBalance: 10,
        hcmBalance: 10,
        pendingDeductions: 3,
      });

      const dataSource = {
        transaction: jest.fn(async (cb: Function) => {
          const manager = {
            findOne: jest.fn().mockResolvedValue(bal),
            save: jest
              .fn()
              .mockImplementation(async (_: unknown, data: Balance) => ({
                ...bal,
                ...data,
              })),
          };
          return cb(manager);
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BalanceService,
          { provide: getRepositoryToken(Balance), useValue: balanceRepo },
          { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
          { provide: HcmClientService, useValue: hcmClient },
          { provide: DataSource, useValue: dataSource },
        ],
      }).compile();

      const svc = module.get(BalanceService);
      const result = await svc.commitDeduction('emp-1', 'loc-1', 3, 7, 'req-1');

      expect(result.localBalance).toBe(7);
      expect(result.hcmBalance).toBe(7);
      expect(result.pendingDeductions).toBe(0);
    });
  });

  // ── applyBatchSync ─────────────────────────────────────────────────────────

  describe('applyBatchSync', () => {
    it('updates existing balances to match HCM values', async () => {
      const existingBalance = makeBalance({ localBalance: 10, hcmBalance: 10 });
      balanceRepo.findOne.mockResolvedValue(existingBalance);
      balanceRepo.save.mockImplementation(async (data: Balance) => data);
      auditRepo.save.mockResolvedValue({});

      const { updated } = await service.applyBatchSync([
        { employeeId: 'emp-1', locationId: 'loc-1', balance: 15 },
      ]);

      expect(updated).toBe(1);
      expect(balanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ localBalance: 15, hcmBalance: 15 }),
      );
    });

    it('creates new balance records for unknown employees', async () => {
      balanceRepo.findOne.mockResolvedValue(null);
      balanceRepo.save.mockResolvedValue({ id: 'new-id' });

      const { created } = await service.applyBatchSync([
        { employeeId: 'emp-new', locationId: 'loc-1', balance: 20 },
      ]);

      expect(created).toBe(1);
    });

    it('processes multiple records in a single call', async () => {
      balanceRepo.findOne
        .mockResolvedValueOnce(makeBalance()) // emp-1 exists
        .mockResolvedValueOnce(null); // emp-2 is new

      balanceRepo.save.mockResolvedValue({});
      auditRepo.save.mockResolvedValue({});

      const { updated, created } = await service.applyBatchSync([
        { employeeId: 'emp-1', locationId: 'loc-1', balance: 10 },
        { employeeId: 'emp-2', locationId: 'loc-1', balance: 5 },
      ]);

      expect(updated).toBe(1);
      expect(created).toBe(1);
    });
  });

  // ── toDto ──────────────────────────────────────────────────────────────────

  describe('toDto', () => {
    it('computes availableBalance = localBalance - pendingDeductions', () => {
      const bal = makeBalance({ localBalance: 10, pendingDeductions: 3 });
      const dto = service.toDto(bal);
      expect(dto.availableBalance).toBe(7);
    });

    it('clamps availableBalance to 0 (never negative)', () => {
      // Edge case: pendingDeductions > localBalance (should not happen in production
      // but we should be defensive)
      const bal = makeBalance({ localBalance: 2, pendingDeductions: 5 });
      const dto = service.toDto(bal);
      expect(dto.availableBalance).toBe(0);
    });
  });
});
