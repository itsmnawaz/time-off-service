import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global exception filter that normalizes all errors to RFC 7807 Problem Details format.
 *
 * Shape:
 *   {
 *     "type":   "https://examplehr.com/errors/insufficient-balance",
 *     "title":  "Conflict",
 *     "status": 409,
 *     "detail": "Insufficient balance: available=5, requested=10",
 *     "instance": "/requests/abc-123"
 *   }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.message
        : 'Internal server error';

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    const detail =
      typeof exceptionResponse === 'object' && exceptionResponse !== null
        ? ((exceptionResponse as Record<string, unknown>).message ?? message)
        : message;

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({
      type: `https://examplehr.com/errors/${status}`,
      title: HttpStatus[status] ?? 'Unknown',
      status,
      detail,
      instance: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
