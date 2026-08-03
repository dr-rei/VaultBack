import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { RequestContextService } from './request-context.service';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(request: FastifyRequest, reply: any, next: () => void) {
    const requestId = String((request as any).id || randomUUID()).slice(0, 128);
    if (typeof reply?.header === 'function') reply.header('x-request-id', requestId);
    else if (typeof reply?.setHeader === 'function') reply.setHeader('x-request-id', requestId);
    else if (typeof reply?.raw?.setHeader === 'function') reply.raw.setHeader('x-request-id', requestId);
    this.context.run(requestId, next);
  }
}
