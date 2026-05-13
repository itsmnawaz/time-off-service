import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import * as http from 'http';
import { createMockHcmApp } from '../mocks/hcm-server/hcm-mock.server';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';

export interface TestContext {
  app: INestApplication;
  hcmServer: http.Server;
  hcmPort: number;
}

let hcmServerPort = 14000;

/**
 * Creates a fully-wired NestJS app backed by an in-memory sql.js database
 * and a real Express mock HCM server on a random port.
 *
 * Each test file gets its own isolated context.
 */
export async function createTestApp(): Promise<TestContext> {
  const port = hcmServerPort++;

  // Start mock HCM
  const hcmApp = createMockHcmApp();
  const hcmServer = await new Promise<http.Server>((resolve) => {
    const server = hcmApp.listen(port, () => resolve(server));
  });

  process.env.HCM_BASE_URL = `http://localhost:${port}`;
  process.env.HCM_API_KEY = 'hcm-api-key';
  process.env.HCM_TIMEOUT_MS = '3000';

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider('TypeOrmModule')
    .useValue({}) // will be handled by AppModule with sqljs
    .compile();

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

  return { app, hcmServer, hcmPort: port };
}

export async function teardownTestApp(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await new Promise<void>((resolve) => ctx.hcmServer.close(() => resolve()));
}

/**
 * Seed the mock HCM server with test balances.
 */
export async function seedHcm(
  port: number,
  records: Array<{
    employeeId: string;
    locationId: string;
    balance: number;
    leaveType?: string;
  }>,
): Promise<void> {
  const response = await fetch(`http://localhost:${port}/admin/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'hcm-api-key' },
    body: JSON.stringify(records),
  });
  if (!response.ok) {
    throw new Error(`HCM seed failed: ${await response.text()}`);
  }
}

export async function resetHcm(port: number): Promise<void> {
  await fetch(`http://localhost:${port}/admin/reset`, {
    method: 'POST',
    headers: { 'x-api-key': 'hcm-api-key' },
  });
}

export async function mutateHcmBalance(
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

export async function getHcmState(port: number) {
  const res = await fetch(`http://localhost:${port}/admin/state`, {
    headers: { 'x-api-key': 'hcm-api-key' },
  });
  return res.json();
}
