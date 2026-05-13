import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceService } from './balance.service';
import { BalanceController } from './balance.controller';
import { Balance } from './entities/balance.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [TypeOrmModule.forFeature([Balance, AuditLog]), HcmModule],
  controllers: [BalanceController],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
