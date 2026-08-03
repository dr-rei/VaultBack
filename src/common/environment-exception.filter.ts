import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class EnvironmentExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(EnvironmentExceptionFilter.name);

  constructor(private readonly production: boolean) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    if (reply.sent) return;

    const isHttpException = exception instanceof HttpException;
    const statusCode = isHttpException ? exception.getStatus() : 500;
    const serverError = statusCode >= 500 && statusCode <= 599;
    const actualMessage = exception instanceof Error ? exception.message : String(exception || 'Unknown error');

    if (serverError) {
      const requestId = String((request as any).id || request.headers['x-request-id'] || 'unknown');
      this.logger.error(`[${requestId}] ${request.method} ${request.url}: ${actualMessage}`, exception instanceof Error ? exception.stack : undefined);
    }

    if (serverError && this.production) {
      return reply.status(statusCode).send({
        statusCode,
        error: 'Internal Server Error',
        message: 'Internal server error',
      });
    }

    if (isHttpException) {
      const response = exception.getResponse();
      return reply.status(statusCode).send(typeof response === 'object' ? response : {
        statusCode,
        error: exception.name,
        message: response,
      });
    }

    return reply.status(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: actualMessage,
    });
  }
}
