import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { RequestService } from './request.service';
import {
  CreateRequestDto,
  ReviewRequestDto,
  CancelRequestDto,
  RequestListQueryDto,
} from './dto/request.dto';

/**
 * REST API surface for time-off requests.
 *
 * GET    /requests                    — list (filterable by employee, status, location)
 * GET    /requests/:id                — get single request
 * POST   /requests                   — employee submits a new request
 * PATCH  /requests/:id/review        — manager approves or rejects
 * DELETE /requests/:id               — employee or admin cancels
 * POST   /requests/:id/retry-hcm     — admin retries a stuck HCM_FAILED request
 */
@Controller('requests')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class RequestController {
  constructor(private readonly requestService: RequestService) {}

  @Get()
  list(@Query() query: RequestListQueryDto) {
    return this.requestService.listRequests(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.requestService.getRequest(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateRequestDto) {
    return this.requestService.createRequest(dto);
  }

  @Patch(':id/review')
  review(@Param('id') id: string, @Body() dto: ReviewRequestDto) {
    return this.requestService.reviewRequest(id, dto);
  }

  @Delete(':id')
  cancel(@Param('id') id: string, @Body() dto: CancelRequestDto) {
    return this.requestService.cancelRequest(id, dto);
  }

  @Post(':id/retry-hcm')
  retryHcm(@Param('id') id: string) {
    return this.requestService.retryHcmSubmission(id);
  }
}
