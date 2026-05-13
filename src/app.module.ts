import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { BalanceModule } from './balance/balance.module';
import { RequestModule } from './request/request.module';
import { SyncModule } from './sync/sync.module';
import { HcmModule } from './hcm/hcm.module';
import { Balance } from './balance/entities/balance.entity';
import { TimeOffRequest } from './request/entities/time-off-request.entity';
import { SyncLog } from './sync/entities/sync-log.entity';
import { AuditLog } from './common/entities/audit-log.entity';
import appConfig from './config/app.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'sqljs',
        autoSave: config.get<boolean>('database.autoSave', false),
        location: config.get<string>('database.location'),
        synchronize: true,
        logging: config.get<boolean>('database.logging', false),
        entities: [Balance, TimeOffRequest, SyncLog, AuditLog],
      }),
    }),
    ScheduleModule.forRoot(),
    HttpModule,
    BalanceModule,
    RequestModule,
    SyncModule,
    HcmModule,
  ],
})
export class AppModule {}
