import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout, catchError } from 'rxjs';
import { throwError } from 'rxjs';
import { AxiosError } from 'axios';

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  balance: number;
  leaveType: string;
  effectiveDate: string;
}

export interface HcmDeductionPayload {
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  startDate: string;
  endDate: string;
  transactionRef: string;
}

export interface HcmDeductionResult {
  success: boolean;
  transactionId: string;
  remainingBalance: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface HcmRollbackPayload {
  transactionId: string;
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  reason: string;
}

export class HcmError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'HcmError';
  }
}

/**
 * Thin HTTP adapter for the HCM system.
 *
 * Responsibilities:
 *  - Translate domain objects ↔ HCM API contracts
 *  - Handle timeouts and surface HCM errors as HcmError
 *  - NO business logic lives here; callers decide what to do with errors
 */
@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'app.hcm.baseUrl',
      'http://localhost:4000',
    );
    this.apiKey = this.configService.get<string>('app.hcm.apiKey', '');
    this.timeoutMs = this.configService.get<number>('app.hcm.timeoutMs', 5000);
  }

  private get headers() {
    return {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Real-time GET of a single employee+location balance from HCM.
   */
  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<HcmBalance> {
    const url = `${this.baseUrl}/hcm/balances/${employeeId}/${locationId}`;
    this.logger.debug(`Fetching HCM balance: ${url}`);

    try {
      const response = await firstValueFrom(
        this.httpService.get<HcmBalance>(url, { headers: this.headers }).pipe(
          timeout(this.timeoutMs),
          catchError((err: AxiosError) => {
            throw this.mapError(err);
          }),
        ),
      );
      return response.data;
    } catch (err) {
      if (err instanceof HcmError) throw err;
      throw new HcmError(
        `HCM getBalance failed: ${(err as Error).message}`,
        'HCM_UNAVAILABLE',
      );
    }
  }

  /**
   * Submit a deduction to HCM (called after manager approval).
   * HCM validates dimensions and balance; errors surface as HcmError.
   */
  async submitDeduction(
    payload: HcmDeductionPayload,
  ): Promise<HcmDeductionResult> {
    const url = `${this.baseUrl}/hcm/deductions`;
    this.logger.debug(`Submitting HCM deduction: ${JSON.stringify(payload)}`);

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<HcmDeductionResult>(url, payload, { headers: this.headers })
          .pipe(
            timeout(this.timeoutMs),
            catchError((err: AxiosError) => {
              throw this.mapError(err);
            }),
          ),
      );
      return response.data;
    } catch (err) {
      if (err instanceof HcmError) throw err;
      throw new HcmError(
        `HCM submitDeduction failed: ${(err as Error).message}`,
        'HCM_UNAVAILABLE',
      );
    }
  }

  /**
   * Roll back a previously committed deduction (e.g., cancellation after approval).
   */
  async rollbackDeduction(payload: HcmRollbackPayload): Promise<void> {
    const url = `${this.baseUrl}/hcm/deductions/${payload.transactionId}/rollback`;
    this.logger.debug(`Rolling back HCM deduction ${payload.transactionId}`);

    try {
      await firstValueFrom(
        this.httpService
          .post<void>(url, payload, { headers: this.headers })
          .pipe(
            timeout(this.timeoutMs),
            catchError((err: AxiosError) => {
              throw this.mapError(err);
            }),
          ),
      );
    } catch (err) {
      if (err instanceof HcmError) throw err;
      throw new HcmError(
        `HCM rollback failed: ${(err as Error).message}`,
        'HCM_UNAVAILABLE',
      );
    }
  }

  /**
   * Pull the full corpus of balances from HCM (batch endpoint).
   * Used by the scheduled batch sync job.
   */
  async getBatchBalances(): Promise<HcmBalance[]> {
    const url = `${this.baseUrl}/hcm/balances/batch`;
    this.logger.debug('Fetching HCM batch balances');

    try {
      const response = await firstValueFrom(
        this.httpService
          .get<HcmBalance[]>(url, {
            headers: this.headers,
            // Batch may return large payloads; use a longer timeout
            timeout: this.timeoutMs * 6,
          })
          .pipe(
            catchError((err: AxiosError) => {
              throw this.mapError(err);
            }),
          ),
      );
      return response.data;
    } catch (err) {
      if (err instanceof HcmError) throw err;
      throw new HcmError(
        `HCM getBatchBalances failed: ${(err as Error).message}`,
        'HCM_UNAVAILABLE',
      );
    }
  }

  private mapError(err: AxiosError): HcmError {
    const status = err.response?.status;
    const body = err.response?.data as Record<string, unknown> | undefined;
    const hcmCode = (body?.code as string) ?? 'HCM_ERROR';
    const hcmMessage = (body?.message as string) ?? err.message;

    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return new HcmError('HCM request timed out', 'HCM_TIMEOUT', status);
    }

    // No response means network-level failure (ECONNREFUSED, DNS, etc.)
    if (!err.response) {
      return new HcmError(`HCM unreachable: ${err.message}`, 'HCM_UNAVAILABLE');
    }

    return new HcmError(hcmMessage, hcmCode, status);
  }
}
