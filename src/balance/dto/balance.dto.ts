import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  IsOptional,
} from 'class-validator';

export class GetBalanceDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;
}

export class UpsertBalanceDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsNumber()
  @Min(0)
  balance: number;

  @IsOptional()
  @IsString()
  source?: string; // 'HCM_BATCH' | 'HCM_REALTIME' | 'MANUAL'
}

export class BalanceResponseDto {
  id: string;
  employeeId: string;
  locationId: string;
  localBalance: number;
  hcmBalance: number;
  pendingDeductions: number;
  availableBalance: number; // localBalance - pendingDeductions
  lastHcmSyncAt: Date | null;
  updatedAt: Date;
}
