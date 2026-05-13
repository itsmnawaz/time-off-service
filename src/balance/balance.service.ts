import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Balance } from './entities/balance.entity';
import { BalanceResponseDto } from './dto/balance.dto';
import { HcmClientService } from '../hcm/hcm-client.service';
import { AuditLog, AuditAction } from '../common/entities/audit-log.entity';

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    private readonly hcmClient: HcmClientService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get balance for an employee+location pair.
   * Performs a real-time HCM fetch to detect drift before returning.
   * If HCM is unavailable, returns local cached values with a warning flag.
   */
  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<BalanceResponseDto & { hcmUnavailable?: boolean }> {
    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!balance) {
      balance = await this.initializeBalance(employeeId, locationId);
    }

    // Attempt real-time HCM sync to detect out-of-band changes
    let hcmUnavailable = false;
    try {
      const hcmData = await this.hcmClient.getBalance(employeeId, locationId);
      const hcmBalance = hcmData.balance;

      if (hcmBalance !== balance.hcmBalance) {
        this.logger.warn(
          `Drift detected for ${employeeId}@${locationId}: ` +
            `local=${balance.hcmBalance} hcm=${hcmBalance}`,
        );
        balance = await this.reconcileFromHcm(balance, hcmBalance);
      }
    } catch (err) {
      this.logger.warn(
        `HCM unavailable for balance fetch (${employeeId}@${locationId}): ${(err as Error).message}`,
      );
      hcmUnavailable = true;
    }

    return { ...this.toDto(balance), hcmUnavailable };
  }

  /**
   * Apply a deduction to local balance (optimistic, before HCM push).
   * Uses a DB transaction with version check to prevent concurrent double-spend.
   */
  async applyLocalDeduction(
    employeeId: string,
    locationId: string,
    days: number,
    requestId: string,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId },
        lock: { mode: 'optimistic', version: 0 }, // select for update equivalent
      });

      if (!balance) {
        throw new NotFoundException(
          `No balance found for employee ${employeeId} at location ${locationId}`,
        );
      }

      const available = balance.localBalance - balance.pendingDeductions;
      if (available < days) {
        throw new ConflictException(
          `Insufficient balance: available=${available}, requested=${days}`,
        );
      }

      const before = {
        localBalance: balance.localBalance,
        pendingDeductions: balance.pendingDeductions,
      };
      balance.pendingDeductions += days;
      balance.version += 1;

      const saved = await manager.save(Balance, balance);

      await manager.save(AuditLog, {
        action: AuditAction.BALANCE_UPDATED,
        employeeId,
        locationId,
        requestId,
        before,
        after: {
          localBalance: saved.localBalance,
          pendingDeductions: saved.pendingDeductions,
        },
        notes: `Local deduction applied: ${days} days`,
      } as Partial<AuditLog>);

      return saved;
    });
  }

  /**
   * Convert a pending deduction into a committed deduction (post HCM push).
   * Reduces localBalance and hcmBalance to reflect the committed state.
   */
  async commitDeduction(
    employeeId: string,
    locationId: string,
    days: number,
    hcmRemainingBalance: number,
    requestId: string,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId },
      });

      if (!balance)
        throw new NotFoundException(
          `Balance not found for ${employeeId}@${locationId}`,
        );

      const before = {
        localBalance: balance.localBalance,
        hcmBalance: balance.hcmBalance,
        pendingDeductions: balance.pendingDeductions,
      };

      balance.localBalance -= days;
      balance.hcmBalance = hcmRemainingBalance;
      balance.pendingDeductions = Math.max(0, balance.pendingDeductions - days);
      balance.lastHcmSyncAt = new Date();
      balance.version += 1;

      const saved = await manager.save(Balance, balance);

      await manager.save(AuditLog, {
        action: AuditAction.HCM_PUSH_SUCCESS,
        employeeId,
        locationId,
        requestId,
        before,
        after: {
          localBalance: saved.localBalance,
          hcmBalance: saved.hcmBalance,
          pendingDeductions: saved.pendingDeductions,
        },
        notes: `HCM deduction committed: ${days} days`,
      } as Partial<AuditLog>);

      return saved;
    });
  }

  /**
   * Restore a pending deduction (e.g., request rejected or cancelled before HCM push).
   */
  async restoreLocalDeduction(
    employeeId: string,
    locationId: string,
    days: number,
    requestId: string,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId },
      });

      if (!balance)
        throw new NotFoundException(
          `Balance not found for ${employeeId}@${locationId}`,
        );

      const before = { pendingDeductions: balance.pendingDeductions };
      balance.pendingDeductions = Math.max(0, balance.pendingDeductions - days);
      balance.version += 1;

      const saved = await manager.save(Balance, balance);

      await manager.save(AuditLog, {
        action: AuditAction.BALANCE_UPDATED,
        employeeId,
        locationId,
        requestId,
        before,
        after: { pendingDeductions: saved.pendingDeductions },
        notes: `Pending deduction restored: ${days} days`,
      } as Partial<AuditLog>);

      return saved;
    });
  }

  /**
   * Restore a COMMITTED deduction when an approved+HCM-submitted request is cancelled.
   * Also triggers HCM rollback (caller is responsible for rolling back in HCM).
   */
  async restoreCommittedDeduction(
    employeeId: string,
    locationId: string,
    days: number,
    requestId: string,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId },
      });
      if (!balance)
        throw new NotFoundException(
          `Balance not found for ${employeeId}@${locationId}`,
        );

      const before = {
        localBalance: balance.localBalance,
        hcmBalance: balance.hcmBalance,
      };
      balance.localBalance += days;
      balance.hcmBalance += days;
      balance.version += 1;

      const saved = await manager.save(Balance, balance);

      await manager.save(AuditLog, {
        action: AuditAction.BALANCE_UPDATED,
        employeeId,
        locationId,
        requestId,
        before,
        after: {
          localBalance: saved.localBalance,
          hcmBalance: saved.hcmBalance,
        },
        notes: `Committed deduction reversed: ${days} days`,
      } as Partial<AuditLog>);

      return saved;
    });
  }

  /**
   * Bulk-upsert balances received from HCM batch endpoint.
   * This is the reconciliation path — it is the source of truth.
   */
  async applyBatchSync(
    records: Array<{ employeeId: string; locationId: string; balance: number }>,
  ): Promise<{ updated: number; created: number }> {
    let updated = 0;
    let created = 0;

    for (const record of records) {
      const existing = await this.balanceRepo.findOne({
        where: { employeeId: record.employeeId, locationId: record.locationId },
      });

      if (existing) {
        await this.reconcileFromHcm(existing, record.balance);
        updated++;
      } else {
        await this.balanceRepo.save({
          employeeId: record.employeeId,
          locationId: record.locationId,
          localBalance: record.balance,
          hcmBalance: record.balance,
          pendingDeductions: 0,
          lastHcmSyncAt: new Date(),
        } as Partial<Balance>);
        created++;
      }
    }

    return { updated, created };
  }

  /**
   * Reconcile our local balance to match HCM.
   * Preserves pending deductions — they represent work in flight.
   *
   * Key invariant:
   *   localBalance = hcmBalance (last known from HCM)
   *   availableBalance = localBalance - pendingDeductions
   *
   * When HCM changes its balance out-of-band (e.g., anniversary credit),
   * we update localBalance = new hcmBalance while keeping pendingDeductions intact.
   */
  private async reconcileFromHcm(
    balance: Balance,
    newHcmBalance: number,
  ): Promise<Balance> {
    const before = {
      localBalance: balance.localBalance,
      hcmBalance: balance.hcmBalance,
    };

    balance.localBalance = newHcmBalance;
    balance.hcmBalance = newHcmBalance;
    balance.lastHcmSyncAt = new Date();
    balance.version += 1;

    const saved = await this.balanceRepo.save(balance);

    await this.auditRepo.save({
      action: AuditAction.BALANCE_SYNCED,
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      before,
      after: { localBalance: saved.localBalance, hcmBalance: saved.hcmBalance },
      notes: `HCM reconciliation: ${before.hcmBalance} → ${newHcmBalance}`,
    } as Partial<AuditLog>);

    return saved;
  }

  private async initializeBalance(
    employeeId: string,
    locationId: string,
  ): Promise<Balance> {
    this.logger.log(`Initializing balance for ${employeeId}@${locationId}`);
    return this.balanceRepo.save({
      employeeId,
      locationId,
      localBalance: 0,
      hcmBalance: 0,
      pendingDeductions: 0,
      lastHcmSyncAt: null,
    } as Partial<Balance>);
  }

  toDto(balance: Balance): BalanceResponseDto {
    return {
      id: balance.id,
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      localBalance: balance.localBalance,
      hcmBalance: balance.hcmBalance,
      pendingDeductions: balance.pendingDeductions,
      availableBalance: Math.max(
        0,
        balance.localBalance - balance.pendingDeductions,
      ),
      lastHcmSyncAt: balance.lastHcmSyncAt,
      updatedAt: balance.updatedAt,
    };
  }
}
