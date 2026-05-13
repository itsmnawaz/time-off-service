import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TimeOffRequest,
  RequestStatus,
} from './entities/time-off-request.entity';
import {
  CreateRequestDto,
  ReviewRequestDto,
  CancelRequestDto,
  RequestListQueryDto,
} from './dto/request.dto';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService, HcmError } from '../hcm/hcm-client.service';
import { AuditLog, AuditAction } from '../common/entities/audit-log.entity';

/**
 * Orchestrates the full lifecycle of a time-off request.
 *
 * State machine:
 *
 *  ┌─────────┐  submit   ┌─────────┐  approve  ┌───────────────┐
 *  │  (none) │ ────────► │ PENDING │ ─────────► │ HCM_SUBMITTED │ (terminal)
 *  └─────────┘           └─────────┘            └───────────────┘
 *                             │                        ▲
 *                             │ reject/cancel          │ HCM push fails
 *                             ▼                        │
 *                        ┌──────────┐     approve  ┌──────────┐
 *                        │ REJECTED │              │APPROVED  │──► HCM_FAILED
 *                        └──────────┘              └──────────┘
 *                                                       │
 *                                                  cancel (post-approval)
 *                                                       ▼
 *                                                  CANCELLED (+ HCM rollback)
 */
@Injectable()
export class RequestService {
  private readonly logger = new Logger(RequestService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
  ) {}

  async listRequests(query: RequestListQueryDto): Promise<TimeOffRequest[]> {
    const where: Partial<TimeOffRequest> = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.status) where.status = query.status;
    if (query.locationId) where.locationId = query.locationId;
    return this.requestRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  async getRequest(id: string): Promise<TimeOffRequest> {
    const req = await this.requestRepo.findOne({ where: { id } });
    if (!req) throw new NotFoundException(`Request ${id} not found`);
    return req;
  }

  /**
   * SUBMIT a new time-off request.
   *
   * Steps:
   *  1. Validate date range
   *  2. Apply optimistic local deduction (fails fast if balance insufficient)
   *  3. Persist request as PENDING
   *  4. Audit log
   */
  async createRequest(dto: CreateRequestDto): Promise<TimeOffRequest> {
    if (new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new BadRequestException('endDate must be >= startDate');
    }

    // Defensive: check local balance BEFORE optimistic deduction
    const balance = await this.balanceService.getBalance(
      dto.employeeId,
      dto.locationId,
    );
    const available = balance.availableBalance;

    if (available < dto.daysRequested) {
      throw new ConflictException(
        `Insufficient balance: available=${available}, requested=${dto.daysRequested}`,
      );
    }

    // Persist the request first (gives us an ID)
    const request = await this.requestRepo.save({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      leaveType: dto.leaveType,
      daysRequested: dto.daysRequested,
      startDate: dto.startDate,
      endDate: dto.endDate,
      reason: dto.reason,
      status: RequestStatus.PENDING,
    } as Partial<TimeOffRequest>);

    try {
      // Apply optimistic local deduction
      await this.balanceService.applyLocalDeduction(
        dto.employeeId,
        dto.locationId,
        dto.daysRequested,
        request.id,
      );
    } catch (err) {
      // If deduction fails (e.g. race condition since our balance check), roll back the request
      await this.requestRepo.remove(request);
      throw err;
    }

    await this.auditRepo.save({
      action: AuditAction.REQUEST_CREATED,
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      requestId: request.id,
      after: { status: request.status, daysRequested: dto.daysRequested },
    } as Partial<AuditLog>);

    return request;
  }

  /**
   * APPROVE or REJECT a pending request (manager action).
   *
   * On APPROVE:
   *  1. Push deduction to HCM immediately
   *  2. On HCM success → commit deduction locally, mark HCM_SUBMITTED
   *  3. On HCM failure → mark HCM_FAILED (pending deduction stays; retry later)
   *
   * On REJECT:
   *  1. Restore the pending local deduction
   *  2. Mark REJECTED
   */
  async reviewRequest(
    id: string,
    dto: ReviewRequestDto,
  ): Promise<TimeOffRequest> {
    const request = await this.getRequest(id);

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `Request ${id} is in status '${request.status}' and cannot be reviewed`,
      );
    }

    if (dto.status === RequestStatus.REJECTED) {
      return this.rejectRequest(request, dto);
    }

    return this.approveRequest(request, dto);
  }

  /**
   * CANCEL a request. Allowed from PENDING, APPROVED, or HCM_FAILED states.
   * For APPROVED requests that were HCM_SUBMITTED, we attempt an HCM rollback.
   */
  async cancelRequest(
    id: string,
    dto: CancelRequestDto,
  ): Promise<TimeOffRequest> {
    const request = await this.getRequest(id);

    const cancellableStatuses = [
      RequestStatus.PENDING,
      RequestStatus.APPROVED,
      RequestStatus.HCM_FAILED,
      RequestStatus.HCM_SUBMITTED,
    ];

    if (!cancellableStatuses.includes(request.status)) {
      throw new BadRequestException(
        `Request ${id} in status '${request.status}' cannot be cancelled`,
      );
    }

    if (request.status === RequestStatus.HCM_SUBMITTED) {
      // Try HCM rollback
      await this.attemptHcmRollback(
        request,
        dto.reason ?? 'Employee cancellation',
      );
      await this.balanceService.restoreCommittedDeduction(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        request.id,
      );
    } else if (request.status === RequestStatus.APPROVED) {
      // Approved but not yet submitted to HCM
      await this.balanceService.restoreLocalDeduction(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        request.id,
      );
    } else {
      // PENDING or HCM_FAILED: restore pending deduction
      await this.balanceService.restoreLocalDeduction(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        request.id,
      );
    }

    request.status = RequestStatus.CANCELLED;
    request.managerComment = dto.reason;
    const saved = await this.requestRepo.save(request);

    await this.auditRepo.save({
      action: AuditAction.REQUEST_CANCELLED,
      employeeId: request.employeeId,
      locationId: request.locationId,
      requestId: request.id,
      performedBy: dto.cancelledBy,
      notes: dto.reason,
    } as Partial<AuditLog>);

    return saved;
  }

  /**
   * Retry HCM submission for requests stuck in HCM_FAILED state.
   * Called by the sync scheduler or manually via API.
   */
  async retryHcmSubmission(id: string): Promise<TimeOffRequest> {
    const request = await this.getRequest(id);

    if (request.status !== RequestStatus.HCM_FAILED) {
      throw new BadRequestException(
        `Request ${id} is not in HCM_FAILED state; current status: ${request.status}`,
      );
    }

    return this.pushToHcm(request);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async approveRequest(
    request: TimeOffRequest,
    dto: ReviewRequestDto,
  ): Promise<TimeOffRequest> {
    request.status = RequestStatus.APPROVED;
    request.reviewedBy = dto.reviewedBy;
    request.reviewedAt = new Date();
    request.managerComment = dto.managerComment;
    await this.requestRepo.save(request);

    await this.auditRepo.save({
      action: AuditAction.REQUEST_APPROVED,
      employeeId: request.employeeId,
      locationId: request.locationId,
      requestId: request.id,
      performedBy: dto.reviewedBy,
    } as Partial<AuditLog>);

    // Immediately push to HCM
    return this.pushToHcm(request);
  }

  private async rejectRequest(
    request: TimeOffRequest,
    dto: ReviewRequestDto,
  ): Promise<TimeOffRequest> {
    // Restore the optimistic deduction
    await this.balanceService.restoreLocalDeduction(
      request.employeeId,
      request.locationId,
      request.daysRequested,
      request.id,
    );

    request.status = RequestStatus.REJECTED;
    request.reviewedBy = dto.reviewedBy;
    request.reviewedAt = new Date();
    request.managerComment = dto.managerComment;
    const saved = await this.requestRepo.save(request);

    await this.auditRepo.save({
      action: AuditAction.REQUEST_REJECTED,
      employeeId: request.employeeId,
      locationId: request.locationId,
      requestId: request.id,
      performedBy: dto.reviewedBy,
      notes: dto.managerComment,
    } as Partial<AuditLog>);

    return saved;
  }

  /**
   * Attempts to commit the deduction in HCM.
   * On success: commit locally, mark HCM_SUBMITTED.
   * On failure: mark HCM_FAILED, leave pending deduction in place for retry.
   */
  private async pushToHcm(request: TimeOffRequest): Promise<TimeOffRequest> {
    try {
      const result = await this.hcmClient.submitDeduction({
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveType: request.leaveType,
        days: request.daysRequested,
        startDate: request.startDate,
        endDate: request.endDate,
        transactionRef: request.id,
      });

      await this.balanceService.commitDeduction(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        result.remainingBalance,
        request.id,
      );

      request.status = RequestStatus.HCM_SUBMITTED;
      request.hcmTransactionId = result.transactionId;
      request.hcmSubmittedAt = new Date();
      request.hcmLastErrorMessage = undefined;

      await this.auditRepo.save({
        action: AuditAction.HCM_PUSH_SUCCESS,
        employeeId: request.employeeId,
        locationId: request.locationId,
        requestId: request.id,
        after: {
          transactionId: result.transactionId,
          remainingBalance: result.remainingBalance,
        },
      } as Partial<AuditLog>);

      return this.requestRepo.save(request);
    } catch (err) {
      const hcmError = err as HcmError;
      this.logger.error(
        `HCM push failed for request ${request.id}: ${hcmError.message} (${hcmError.code})`,
      );

      request.status = RequestStatus.HCM_FAILED;
      request.hcmRetryCount += 1;
      request.hcmLastErrorMessage = `${hcmError.code}: ${hcmError.message}`;

      await this.auditRepo.save({
        action: AuditAction.HCM_PUSH_FAILED,
        employeeId: request.employeeId,
        locationId: request.locationId,
        requestId: request.id,
        notes: request.hcmLastErrorMessage,
      } as Partial<AuditLog>);

      return this.requestRepo.save(request);
    }
  }

  private async attemptHcmRollback(
    request: TimeOffRequest,
    reason: string,
  ): Promise<void> {
    if (!request.hcmTransactionId) {
      this.logger.warn(
        `No HCM transactionId on request ${request.id}; skipping rollback`,
      );
      return;
    }

    try {
      await this.hcmClient.rollbackDeduction({
        transactionId: request.hcmTransactionId,
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveType: request.leaveType,
        days: request.daysRequested,
        reason,
      });
    } catch (err) {
      // Rollback failure is logged but does not block the cancellation.
      // Operations team must reconcile manually via the next batch sync.
      this.logger.error(
        `HCM rollback failed for request ${request.id}: ${(err as Error).message}`,
      );
    }
  }
}
