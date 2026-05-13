import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SyncService } from './sync.service';
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  IsOptional,
} from 'class-validator';

class WebhookDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsNumber()
  @Min(0)
  balance: number;
}

/**
 * Sync-management endpoints.
 *
 * POST /sync/webhook          — HCM pushes a balance update to us
 * POST /sync/manual           — Admin triggers immediate batch sync
 * GET  /sync/history          — Operational view of recent sync runs
 */
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /**
   * HCM calls this when it changes a balance out-of-band
   * (e.g. work anniversary, year-start refresh).
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  webhook(@Body() dto: WebhookDto) {
    return this.syncService.handleWebhookUpdate(
      dto.employeeId,
      dto.locationId,
      dto.balance,
    );
  }

  /**
   * Admin trigger for immediate batch reconciliation.
   * Useful after suspected drift or for testing.
   */
  @Post('manual')
  @HttpCode(HttpStatus.ACCEPTED)
  manual() {
    // Fire-and-forget; returns immediately, sync runs async
    void this.syncService.triggerManualSync();
    return { message: 'Batch sync triggered' };
  }

  @Get('history')
  history(@Query('limit') limit?: string) {
    return this.syncService.getSyncHistory(limit ? parseInt(limit, 10) : 50);
  }
}
