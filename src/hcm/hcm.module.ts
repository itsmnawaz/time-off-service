import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HcmClientService } from './hcm-client.service';

@Module({
  imports: [HttpModule],
  providers: [HcmClientService],
  exports: [HcmClientService],
})
export class HcmModule {}
