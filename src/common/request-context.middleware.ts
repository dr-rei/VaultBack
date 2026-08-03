import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { RequestContextService } from './request-context.service';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(request: FastifyRequest, reply: FastifyReply, next: () => void) {
    const requestId = String((request as any).id || randomUUID()).slice(0, 128);
    reply.header('x-request-id', requestId);
    this.context.run(requestId, next);
  }
}
