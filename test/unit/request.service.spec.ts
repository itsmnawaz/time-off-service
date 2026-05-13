import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RequestService } from '../../src/request/request.service';
import {
  TimeOffRequest,
  RequestStatus,
  LeaveType,
} from '../../src/request/entities/time-off-request.entity';
import {
  AuditLog,
  AuditAction,
} from '../../src/common/entities/audit-log.entity';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmClientService, HcmError } from '../../src/hcm/hcm-client.service';
import {
  CreateRequestDto,
  ReviewRequestDto,
  CancelRequestDto,
} from '../../src/request/dto/request.dto';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<TimeOffRequest> = {}): TimeOffRequest {
  return {
    id: 'req-1',
    employeeId: 'emp-1',
    locationId: 'loc-1',
    leaveType: LeaveType.VACATION,
    daysRequested: 3,
    startDate: '2026-06-01',
    endDate: '2026-06-03',
    status: RequestStatus.PENDING,
    reason: 'Holiday',
    managerComment: null,
    reviewedBy: null,
    reviewedAt: null,
    hcmTransactionId: null,
    hcmSubmittedAt: null,
    hcmRetryCount: 0,
    hcmLastErrorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    save: jest
      .fn()
      .mockImplementation(async (data: Partial<TimeOffRequest>) => ({
        ...makeRequest(),
        ...data,
      })),
    remove: jest.fn(),
    ...overrides,
  };
}

function makeMockBalanceService(): jest.Mocked<BalanceService> {
  return {
    getBalance: jest
      .fn()
      .mockResolvedValue({ availableBalance: 10, localBalance: 10 }),
    applyLocalDeduction: jest.fn().mockResolvedValue({}),
    commitDeduction: jest.fn().mockResolvedValue({}),
    restoreLocalDeduction: jest.fn().mockResolvedValue({}),
    restoreCommittedDeduction: jest.fn().mockResolvedValue({}),
    applyBatchSync: jest.fn().mockResolvedValue({ updated: 0, created: 0 }),
    toDto: jest.fn(),
  } as unknown as jest.Mocked<BalanceService>;
}

function makeMockHcmClient(): jest.Mocked<HcmClientService> {
  return {
    getBalance: jest.fn(),
    submitDeduction: jest.fn().mockResolvedValue({
      success: true,
      transactionId: 'tx-1',
      remainingBalance: 7,
    }),
    rollbackDeduction: jest.fn().mockResolvedValue(undefined),
    getBatchBalances: jest.fn(),
  } as unknown as jest.Mocked<HcmClientService>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RequestService', () => {
  let service: RequestService;
  let requestRepo: ReturnType<typeof makeMockRepo>;
  let auditRepo: ReturnType<typeof makeMockRepo>;
  let balanceService: jest.Mocked<BalanceService>;
  let hcmClient: jest.Mocked<HcmClientService>;

  beforeEach(async () => {
    requestRepo = makeMockRepo();
    auditRepo = makeMockRepo();
    balanceService = makeMockBalanceService();
    hcmClient = makeMockHcmClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmClientService, useValue: hcmClient },
      ],
    }).compile();

    service = module.get(RequestService);
  });

  // ── createRequest ──────────────────────────────────────────────────────────

  describe('createRequest', () => {
    const dto: CreateRequestDto = {
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveType: LeaveType.VACATION,
      daysRequested: 3,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
    };

    it('creates a PENDING request and applies a local deduction', async () => {
      const result = await service.createRequest(dto);

      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: RequestStatus.PENDING }),
      );
      expect(balanceService.applyLocalDeduction).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        3,
        expect.any(String),
      );
      expect(auditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REQUEST_CREATED }),
      );
    });

    it('throws ConflictException when balance is insufficient', async () => {
      balanceService.getBalance.mockResolvedValue({
        availableBalance: 1,
      } as any);

      await expect(
        service.createRequest({ ...dto, daysRequested: 5 }),
      ).rejects.toThrow(ConflictException);
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when endDate is before startDate', async () => {
      await expect(
        service.createRequest({
          ...dto,
          startDate: '2026-06-10',
          endDate: '2026-06-01',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('removes the request if local deduction fails due to race condition', async () => {
      balanceService.applyLocalDeduction.mockRejectedValue(
        new ConflictException('Insufficient balance'),
      );

      await expect(service.createRequest(dto)).rejects.toThrow(
        ConflictException,
      );
      expect(requestRepo.remove).toHaveBeenCalled();
    });

    it('writes an audit log on successful creation', async () => {
      await service.createRequest(dto);
      expect(auditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REQUEST_CREATED }),
      );
    });
  });

  // ── reviewRequest (APPROVE) ────────────────────────────────────────────────

  describe('reviewRequest → APPROVE', () => {
    const reviewDto: ReviewRequestDto = {
      status: RequestStatus.APPROVED,
      reviewedBy: 'manager-1',
      managerComment: 'Enjoy your holiday',
    };

    it('approves the request and pushes to HCM on success', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest());

      const result = await service.reviewRequest('req-1', reviewDto);

      expect(hcmClient.submitDeduction).toHaveBeenCalled();
      expect(balanceService.commitDeduction).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        3,
        7,
        expect.any(String),
      );
      expect(result.status).toBe(RequestStatus.HCM_SUBMITTED);
      expect(result.hcmTransactionId).toBe('tx-1');
    });

    it('marks HCM_FAILED when HCM push fails, keeping pending deduction', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest());
      hcmClient.submitDeduction.mockRejectedValue(
        new HcmError('Connection refused', 'HCM_UNAVAILABLE'),
      );

      const result = await service.reviewRequest('req-1', reviewDto);

      expect(result.status).toBe(RequestStatus.HCM_FAILED);
      expect(balanceService.commitDeduction).not.toHaveBeenCalled();
      // Pending deduction stays in place for retry
      expect(balanceService.restoreLocalDeduction).not.toHaveBeenCalled();
    });

    it('marks HCM_FAILED when HCM rejects with INSUFFICIENT_BALANCE', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest());
      hcmClient.submitDeduction.mockRejectedValue(
        new HcmError('HCM balance insufficient', 'INSUFFICIENT_BALANCE', 422),
      );

      const result = await service.reviewRequest('req-1', reviewDto);

      expect(result.status).toBe(RequestStatus.HCM_FAILED);
      expect(result.hcmLastErrorMessage).toContain('INSUFFICIENT_BALANCE');
      expect(result.hcmRetryCount).toBe(1);
    });

    it('throws BadRequestException when request is not PENDING', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: RequestStatus.APPROVED }),
      );

      await expect(service.reviewRequest('req-1', reviewDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('writes APPROVED and HCM_PUSH_SUCCESS audit logs', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest());

      await service.reviewRequest('req-1', reviewDto);

      const auditCalls = auditRepo.save.mock.calls.map(([a]) => a.action);
      expect(auditCalls).toContain(AuditAction.REQUEST_APPROVED);
      expect(auditCalls).toContain(AuditAction.HCM_PUSH_SUCCESS);
    });
  });

  // ── reviewRequest (REJECT) ─────────────────────────────────────────────────

  describe('reviewRequest → REJECT', () => {
    const rejectDto: ReviewRequestDto = {
      status: RequestStatus.REJECTED,
      reviewedBy: 'manager-1',
      managerComment: 'Team already at capacity',
    };

    it('restores the pending deduction on rejection', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest());

      const result = await service.reviewRequest('req-1', rejectDto);

      expect(balanceService.restoreLocalDeduction).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        3,
        'req-1',
      );
      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(hcmClient.submitDeduction).not.toHaveBeenCalled();
    });

    it('writes REQUEST_REJECTED audit log', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest());

      await service.reviewRequest('req-1', rejectDto);

      expect(auditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REQUEST_REJECTED }),
      );
    });
  });

  // ── cancelRequest ──────────────────────────────────────────────────────────

  describe('cancelRequest', () => {
    const cancelDto: CancelRequestDto = {
      cancelledBy: 'emp-1',
      reason: 'Plans changed',
    };

    it('restores pending deduction when cancelling a PENDING request', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: RequestStatus.PENDING }),
      );

      const result = await service.cancelRequest('req-1', cancelDto);

      expect(balanceService.restoreLocalDeduction).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        3,
        'req-1',
      );
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('restores pending deduction when cancelling an APPROVED (not yet HCM submitted) request', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: RequestStatus.APPROVED }),
      );

      const result = await service.cancelRequest('req-1', cancelDto);

      expect(balanceService.restoreLocalDeduction).toHaveBeenCalled();
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('attempts HCM rollback and restores committed deduction for HCM_SUBMITTED request', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({
          status: RequestStatus.HCM_SUBMITTED,
          hcmTransactionId: 'tx-abc',
        }),
      );

      const result = await service.cancelRequest('req-1', cancelDto);

      expect(hcmClient.rollbackDeduction).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: 'tx-abc' }),
      );
      expect(balanceService.restoreCommittedDeduction).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        3,
        'req-1',
      );
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('still cancels locally even if HCM rollback fails (logs error, does not throw)', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({
          status: RequestStatus.HCM_SUBMITTED,
          hcmTransactionId: 'tx-abc',
        }),
      );
      hcmClient.rollbackDeduction.mockRejectedValue(new Error('HCM timeout'));

      // Should NOT throw
      const result = await service.cancelRequest('req-1', cancelDto);
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('throws BadRequestException when cancelling a REJECTED request', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: RequestStatus.REJECTED }),
      );

      await expect(service.cancelRequest('req-1', cancelDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when request does not exist', async () => {
      requestRepo.findOne.mockResolvedValue(null);

      await expect(
        service.cancelRequest('nonexistent', cancelDto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── retryHcmSubmission ─────────────────────────────────────────────────────

  describe('retryHcmSubmission', () => {
    it('pushes to HCM and transitions to HCM_SUBMITTED on success', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: RequestStatus.HCM_FAILED, hcmRetryCount: 1 }),
      );

      const result = await service.retryHcmSubmission('req-1');

      expect(hcmClient.submitDeduction).toHaveBeenCalled();
      expect(result.status).toBe(RequestStatus.HCM_SUBMITTED);
    });

    it('throws BadRequestException when request is not in HCM_FAILED state', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: RequestStatus.PENDING }),
      );

      await expect(service.retryHcmSubmission('req-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('increments hcmRetryCount on repeated failure', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: RequestStatus.HCM_FAILED, hcmRetryCount: 1 }),
      );
      hcmClient.submitDeduction.mockRejectedValue(
        new HcmError('Still down', 'HCM_UNAVAILABLE'),
      );

      const result = await service.retryHcmSubmission('req-1');

      expect(result.status).toBe(RequestStatus.HCM_FAILED);
      expect(result.hcmRetryCount).toBe(2);
    });
  });

  // ── listRequests ───────────────────────────────────────────────────────────

  describe('listRequests', () => {
    it('passes filter parameters to the repository', async () => {
      await service.listRequests({
        employeeId: 'emp-1',
        status: RequestStatus.PENDING,
      });

      expect(requestRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { employeeId: 'emp-1', status: RequestStatus.PENDING },
        }),
      );
    });

    it('returns all requests when no filters provided', async () => {
      requestRepo.find.mockResolvedValue([
        makeRequest(),
        makeRequest({ id: 'req-2' }),
      ]);
      const result = await service.listRequests({});
      expect(result).toHaveLength(2);
    });
  });
});
