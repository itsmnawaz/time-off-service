import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService } from '../hcm/hcm-client.service';
import { RequestService } from '../request/request.service';
import { SyncLog, SyncStatus, SyncType } from './entities/sync-log.entity';
import {
  TimeOffRequest,
  RequestStatus,
} from '../request/entities/time-off-request.entity';
import { AuditLog, AuditAction } from '../common/entities/audit-log.entity';

/**
 * SyncService owns two reconciliation paths:
 *
 * 1. Scheduled batch sync (nightly by default):
 *    - Pulls all balances from HCM batch endpoint
 *    - Upserts them into our local store
 *    - Retries any HCM_FAILED requests
 *
 * 2. HCM-push webhook handler:
 *    - HCM notifies us when it changes a balance out-of-band
 *    - We update local balance immediately
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private isBatchRunning = false;

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
    private readonly requestService: RequestService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Nightly batch sync with HCM (configurable via HCM_BATCH_SYNC_CRON env var).
   * Default: 2 AM daily.
   */
  @Cron('0 2 * * *', { name: 'hcm-batch-sync' })
  async runBatchSync(): Promise<SyncLog> {
    if (this.isBatchRunning) {
      this.logger.warn('Batch sync already in progress; skipping');
      return this.syncLogRepo.save({
        syncType: SyncType.BATCH,
        status: SyncStatus.FAILED,
        errorMessage: 'Skipped: previous batch still running',
      } as Partial<SyncLog>);
    }

    this.isBatchRunning = true;
    this.logger.log('Starting HCM batch sync');

    await this.auditRepo.save({
      action: AuditAction.BATCH_SYNC_STARTED,
      notes: 'Scheduled batch sync initiated',
    } as Partial<AuditLog>);

    let syncLog: SyncLog;

    try {
      const hcmRecords = await this.hcmClient.getBatchBalances();
      const { updated, created } =
        await this.balanceService.applyBatchSync(hcmRecords);

      // Retry any stuck HCM_FAILED requests
      const retriedCount = await this.retryFailedRequests();

      syncLog = await this.syncLogRepo.save({
        syncType: SyncType.BATCH,
        status: SyncStatus.SUCCESS,
        recordsProcessed: hcmRecords.length,
        recordsUpdated: updated,
        recordsFailed: 0,
        details: { created, updated, retriedRequests: retriedCount },
      } as Partial<SyncLog>);

      await this.auditRepo.save({
        action: AuditAction.BATCH_SYNC_COMPLETED,
        notes: `Processed ${hcmRecords.length} records; ${updated} updated, ${created} created, ${retriedCount} retried`,
      } as Partial<AuditLog>);

      this.logger.log(
        `Batch sync complete: ${hcmRecords.length} records, ${updated} updated, ${created} created`,
      );
    } catch (err) {
      this.logger.error(`Batch sync failed: ${(err as Error).message}`);
      syncLog = await this.syncLogRepo.save({
        syncType: SyncType.BATCH,
        status: SyncStatus.FAILED,
        errorMessage: (err as Error).message,
        recordsProcessed: 0,
        recordsUpdated: 0,
        recordsFailed: 0,
      } as Partial<SyncLog>);
    } finally {
      this.isBatchRunning = false;
    }

    return syncLog;
  }

  /**
   * Triggered by manual admin action or tests.
   * Same as the cron job but bypasses the isBatchRunning guard.
   */
  async triggerManualSync(): Promise<SyncLog> {
    const wasRunning = this.isBatchRunning;
    this.isBatchRunning = false;
    const result = await this.runBatchSync();
    return result;
  }

  /**
   * Handle an HCM webhook push: a single balance change notification.
   * Called by the SyncController when HCM POSTs to /sync/webhook.
   */
  async handleWebhookUpdate(
    employeeId: string,
    locationId: string,
    newBalance: number,
  ): Promise<SyncLog> {
    this.logger.log(
      `Webhook: balance update for ${employeeId}@${locationId} → ${newBalance}`,
    );

    try {
      await this.balanceService.applyBatchSync([
        { employeeId, locationId, balance: newBalance },
      ]);

      return this.syncLogRepo.save({
        syncType: SyncType.WEBHOOK,
        status: SyncStatus.SUCCESS,
        employeeId,
        locationId,
        recordsProcessed: 1,
        recordsUpdated: 1,
      } as Partial<SyncLog>);
    } catch (err) {
      return this.syncLogRepo.save({
        syncType: SyncType.WEBHOOK,
        status: SyncStatus.FAILED,
        employeeId,
        locationId,
        errorMessage: (err as Error).message,
        recordsProcessed: 1,
        recordsFailed: 1,
      } as Partial<SyncLog>);
    }
  }

  /**
   * Return recent sync history (for operational dashboards).
   */
  async getSyncHistory(limit = 50): Promise<SyncLog[]> {
    return this.syncLogRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Retry all HCM_FAILED requests. Cap at 3 previous attempts to avoid
   * infinite retry for truly broken requests (ops intervention needed).
   */
  private async retryFailedRequests(): Promise<number> {
    const failedRequests = await this.requestRepo.find({
      where: { status: RequestStatus.HCM_FAILED },
    });

    const eligible = failedRequests.filter((r) => r.hcmRetryCount < 3);
    let retriedCount = 0;

    for (const req of eligible) {
      try {
        await this.requestService.retryHcmSubmission(req.id);
        retriedCount++;
      } catch (err) {
        this.logger.warn(
          `Retry failed for request ${req.id}: ${(err as Error).message}`,
        );
      }
    }

    return retriedCount;
  }
}
