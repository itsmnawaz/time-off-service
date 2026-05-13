import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsNumber,
  Min,
  Max,
  IsDateString,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { LeaveType, RequestStatus } from '../entities/time-off-request.entity';

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsEnum(LeaveType)
  leaveType: LeaveType;

  @IsNumber()
  @Min(0.5)
  @Max(365)
  daysRequested: number;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ReviewRequestDto {
  @IsEnum([RequestStatus.APPROVED, RequestStatus.REJECTED])
  status: RequestStatus.APPROVED | RequestStatus.REJECTED;

  @IsString()
  @IsNotEmpty()
  reviewedBy: string;

  @IsOptional()
  @IsString()
  managerComment?: string;
}

export class CancelRequestDto {
  @IsString()
  @IsNotEmpty()
  cancelledBy: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class RequestListQueryDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @IsOptional()
  @IsString()
  locationId?: string;
}
