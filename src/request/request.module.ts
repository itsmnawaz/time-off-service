import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestService } from './request.service';
import { RequestController } from './request.controller';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { BalanceModule } from '../balance/balance.module';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, AuditLog]),
    BalanceModule,
    HcmModule,
  ],
  controllers: [RequestController],
  providers: [RequestService],
  exports: [RequestService],
})
export class RequestModule {}
