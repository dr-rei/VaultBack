import { RequestContextMiddleware } from '../src/common/request-context.middleware';
import { RequestContextService } from '../src/common/request-context.service';

describe('RequestContextMiddleware', () => {
  it('supports the raw response object used by Nest Fastify middleware', () => {
    const context = new RequestContextService();
    const middleware = new RequestContextMiddleware(context);
    const headers: Record<string, string> = {};

    middleware.use(
      { id: 'req-fastify-raw' } as any,
      { setHeader: (name: string, value: string) => { headers[name] = value; } },
      () => { expect(context.getRequestId()).toBe('req-fastify-raw'); }
    );

    expect(headers['x-request-id']).toBe('req-fastify-raw');
  });
});
