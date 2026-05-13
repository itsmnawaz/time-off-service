import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SyncLog } from './entities/sync-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { TimeOffRequest } from '../request/entities/time-off-request.entity';
import { BalanceModule } from '../balance/balance.module';
import { HcmModule } from '../hcm/hcm.module';
import { RequestModule } from '../request/request.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncLog, AuditLog, TimeOffRequest]),
    BalanceModule,
    HcmModule,
    RequestModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
