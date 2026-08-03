import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

@Catch()
export class EnvironmentExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(EnvironmentExceptionFilter.name);

  constructor(private readonly production: boolean) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply: any = context.getResponse();
    if (reply.sent || reply.writableEnded) return;

    const isHttpException = exception instanceof HttpException;
    const statusCode = isHttpException ? exception.getStatus() : 500;
    const serverError = statusCode >= 500 && statusCode <= 599;
    const actualMessage = exception instanceof Error ? exception.message : String(exception || 'Unknown error');

    if (serverError) {
      const requestId = String((request as any).id || request.headers['x-request-id'] || 'unknown');
      this.logger.error(`[${requestId}] ${request.method} ${request.url}: ${actualMessage}`, exception instanceof Error ? exception.stack : undefined);
    }

    const send = (status: number, payload: unknown) => {
      if (typeof reply.status === 'function') return reply.status(status).send(payload);
      const raw = reply.raw || reply;
      raw.statusCode = status;
      if (typeof raw.setHeader === 'function') raw.setHeader('content-type', 'application/json; charset=utf-8');
      if (typeof raw.end === 'function') return raw.end(JSON.stringify(payload));
      return undefined;
    };

    if (serverError && this.production) {
      return send(statusCode, {
        statusCode,
        error: 'Internal Server Error',
        message: 'Internal server error',
      });
    }

    if (isHttpException) {
      const response = exception.getResponse();
      return send(statusCode, typeof response === 'object' ? response : {
        statusCode,
        error: exception.name,
        message: response,
      });
    }

    return send(500, {
      statusCode: 500,
      error: 'Internal Server Error',
      message: actualMessage,
    });
  }
}
