import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { AxiosResponse, AxiosError } from 'axios';
import { HcmClientService, HcmError } from '../../src/hcm/hcm-client.service';

function mockAxiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} } as any,
  };
}

function mockAxiosError(
  status: number,
  data: Record<string, unknown>,
): AxiosError {
  const err = new Error('Request failed') as AxiosError;
  err.isAxiosError = true;
  err.response = {
    data,
    status,
    statusText: 'Error',
    headers: {},
    config: { headers: {} } as any,
  };
  return err;
}

describe('HcmClientService', () => {
  let service: HcmClientService;
  let httpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    httpService = {
      get: jest.fn(),
      post: jest.fn(),
    } as unknown as jest.Mocked<HttpService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmClientService,
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) => {
              const map: Record<string, unknown> = {
                'app.hcm.baseUrl': 'http://localhost:4000',
                'app.hcm.apiKey': 'hcm-api-key',
                'app.hcm.timeoutMs': 3000,
              };
              return map[key] ?? def;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(HcmClientService);
  });

  describe('getBalance', () => {
    it('returns balance data on success', async () => {
      const payload = {
        employeeId: 'emp-1',
        locationId: 'loc-1',
        balance: 10,
        leaveType: 'VACATION',
        effectiveDate: '2026-01-01',
      };
      httpService.get.mockReturnValue(of(mockAxiosResponse(payload)));
      const result = await service.getBalance('emp-1', 'loc-1');
      expect(result.balance).toBe(10);
    });

    it('throws HcmError with correct code on 404', async () => {
      httpService.get.mockReturnValue(
        throwError(() =>
          mockAxiosError(404, {
            code: 'EMPLOYEE_LOCATION_NOT_FOUND',
            message: 'Not found',
          }),
        ),
      );
      await expect(service.getBalance('emp-x', 'loc-x')).rejects.toMatchObject({
        code: 'EMPLOYEE_LOCATION_NOT_FOUND',
      });
    });

    it('throws HcmError with HCM_UNAVAILABLE on network error', async () => {
      const netErr = new Error('ECONNREFUSED') as AxiosError;
      netErr.isAxiosError = true;
      httpService.get.mockReturnValue(throwError(() => netErr));
      await expect(service.getBalance('emp-1', 'loc-1')).rejects.toMatchObject({
        code: 'HCM_UNAVAILABLE',
      });
    });
  });

  describe('submitDeduction', () => {
    const payload = {
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveType: 'VACATION',
      days: 3,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      transactionRef: 'req-1',
    };

    it('returns transaction result on success', async () => {
      httpService.post.mockReturnValue(
        of(
          mockAxiosResponse({
            success: true,
            transactionId: 'tx-1',
            remainingBalance: 7,
          }),
        ),
      );
      const result = await service.submitDeduction(payload);
      expect(result.transactionId).toBe('tx-1');
      expect(result.remainingBalance).toBe(7);
    });

    it('throws HcmError with INSUFFICIENT_BALANCE code on 422', async () => {
      httpService.post.mockReturnValue(
        throwError(() =>
          mockAxiosError(422, {
            code: 'INSUFFICIENT_BALANCE',
            message: 'Not enough balance',
          }),
        ),
      );
      await expect(service.submitDeduction(payload)).rejects.toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
        statusCode: 422,
      });
    });

    it('throws HcmError with INVALID_LEAVE_TYPE when leave type unknown', async () => {
      httpService.post.mockReturnValue(
        throwError(() =>
          mockAxiosError(422, {
            code: 'INVALID_LEAVE_TYPE',
            message: 'Unknown type',
          }),
        ),
      );
      await expect(
        service.submitDeduction({ ...payload, leaveType: 'FANTASY' }),
      ).rejects.toMatchObject({ code: 'INVALID_LEAVE_TYPE' });
    });
  });

  describe('rollbackDeduction', () => {
    it('resolves without error on success', async () => {
      httpService.post.mockReturnValue(
        of(mockAxiosResponse({ success: true })),
      );
      await expect(
        service.rollbackDeduction({
          transactionId: 'tx-1',
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'VACATION',
          days: 3,
          reason: 'Cancellation',
        }),
      ).resolves.toBeUndefined();
    });

    it('throws HcmError on rollback failure', async () => {
      httpService.post.mockReturnValue(
        throwError(() =>
          mockAxiosError(404, {
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Tx not found',
          }),
        ),
      );
      await expect(
        service.rollbackDeduction({
          transactionId: 'tx-bad',
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveType: 'VACATION',
          days: 3,
          reason: 'Cancellation',
        }),
      ).rejects.toThrow(HcmError);
    });
  });

  describe('getBatchBalances', () => {
    it('returns array of balance records', async () => {
      const records = [
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
          leaveType: 'SICK',
          effectiveDate: '2026-01-01',
        },
      ];
      httpService.get.mockReturnValue(of(mockAxiosResponse(records)));
      const result = await service.getBatchBalances();
      expect(result).toHaveLength(2);
    });

    it('throws HcmError when batch endpoint fails', async () => {
      httpService.get.mockReturnValue(
        throwError(() =>
          mockAxiosError(503, {
            code: 'SERVICE_UNAVAILABLE',
            message: 'HCM down',
          }),
        ),
      );
      await expect(service.getBatchBalances()).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    });
  });
});
