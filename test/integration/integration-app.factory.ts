import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import * as http from 'http';
import { createMockHcmApp } from '../mocks/hcm-server/hcm-mock.server';
import { BalanceModule } from '../../src/balance/balance.module';
import { RequestModule } from '../../src/request/request.module';
import { SyncModule } from '../../src/sync/sync.module';
import { HcmModule } from '../../src/hcm/hcm.module';
import { Balance } from '../../src/balance/entities/balance.entity';
import { TimeOffRequest } from '../../src/request/entities/time-off-request.entity';
import { SyncLog } from '../../src/sync/entities/sync-log.entity';
import { AuditLog } from '../../src/common/entities/audit-log.entity';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import appConfig from '../../src/config/app.config';

// Unique port per parallel test file
let nextPort = 15000;

export interface IntegrationContext {
  app: INestApplication;
  hcmServer: http.Server;
  hcmPort: number;
}

export async function createIntegrationApp(): Promise<IntegrationContext> {
  const hcmPort = nextPort++;

  // Start real Express mock HCM server FIRST
  const hcmExpressApp = createMockHcmApp();
  const hcmServer = await new Promise<http.Server>((resolve) => {
    const s = hcmExpressApp.listen(hcmPort, () => resolve(s));
  });

  // Set env vars BEFORE module compilation so ConfigService picks them up
  process.env['HCM_BASE_URL'] = `http://localhost:${hcmPort}`;
  process.env['HCM_API_KEY'] = 'hcm-api-key';
  process.env['HCM_TIMEOUT_MS'] = '3000';

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [appConfig],
        // Ignore .env files in tests — use process.env set above
        ignoreEnvFile: true,
      }),
      TypeOrmModule.forRoot({
        type: 'sqljs',
        synchronize: true,
        logging: false,
        entities: [Balance, TimeOffRequest, SyncLog, AuditLog],
        // No location = pure in-memory, isolated per test module instance
      }),
      ScheduleModule.forRoot(),
      HttpModule,
      BalanceModule,
      RequestModule,
      SyncModule,
      HcmModule,
    ],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  return { app, hcmServer, hcmPort };
}

export async function teardownIntegrationApp(
  ctx: IntegrationContext,
): Promise<void> {
  await ctx.app.close();
  await new Promise<void>((resolve) => ctx.hcmServer.close(() => resolve()));
}

export async function hcmSeed(
  port: number,
  records: Array<{
    employeeId: string;
    locationId: string;
    balance: number;
    leaveType?: string;
  }>,
): Promise<void> {
  const res = await fetch(`http://localhost:${port}/admin/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'hcm-api-key' },
    body: JSON.stringify(records),
  });
  if (!res.ok) throw new Error(`HCM seed failed: ${await res.text()}`);
}

export async function hcmMutate(
  port: number,
  employeeId: string,
  locationId: string,
  newBalance: number,
): Promise<void> {
  await fetch(`http://localhost:${port}/admin/mutate-balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'hcm-api-key' },
    body: JSON.stringify({ employeeId, locationId, newBalance }),
  });
}

export async function hcmGetState(port: number): Promise<{
  balances: Record<string, { balance: number }>;
  transactions: Record<string, { status: string; days: number }>;
}> {
  const res = await fetch(`http://localhost:${port}/admin/state`, {
    headers: { 'x-api-key': 'hcm-api-key' },
  });
  return res.json() as Promise<{
    balances: Record<string, { balance: number }>;
    transactions: Record<string, { status: string; days: number }>;
  }>;
}

export async function hcmReset(port: number): Promise<void> {
  await fetch(`http://localhost:${port}/admin/reset`, {
    method: 'POST',
    headers: { 'x-api-key': 'hcm-api-key' },
  });
}
