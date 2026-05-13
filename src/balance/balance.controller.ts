import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { BalanceService } from './balance.service';
import { UpsertBalanceDto } from './dto/balance.dto';

/**
 * REST endpoints for balance inspection and administrative overrides.
 *
 * GET  /balances/:employeeId/:locationId  — view current balance (triggers real-time HCM check)
 * POST /balances/upsert                  — admin/internal: manually set a balance (audit-logged)
 */
@Controller('balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.balanceService.getBalance(employeeId, locationId);
  }

  /**
   * Admin endpoint: push an HCM-sourced balance update directly.
   * Used by the webhook handler and internal tools.
   */
  @Post('upsert')
  @HttpCode(HttpStatus.OK)
  async upsertBalance(@Body() dto: UpsertBalanceDto) {
    await this.balanceService.applyBatchSync([
      {
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        balance: dto.balance,
      },
    ]);
    return this.balanceService.getBalance(dto.employeeId, dto.locationId);
  }
}
