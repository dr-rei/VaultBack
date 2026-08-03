import { Test, TestingModule } from '@nestjs/testing';
import { RequestContextService } from '../src/common/request-context.service';

describe('RequestContextService', () => {
  let module: TestingModule;
  let context: RequestContextService;

  beforeEach(async () => {
    module = await Test.createTestingModule({ providers: [RequestContextService] }).compile();
    context = module.get(RequestContextService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('keeps the request ID available across async work', async () => {
    await new Promise<void>((resolve, reject) => {
      context.run('request-test-123', async () => {
        try {
          await Promise.resolve();
          expect(context.getRequestId()).toBe('request-test-123');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  it('returns an empty ID outside a request context', () => {
    expect(context.getRequestId()).toBe('');
  });
});
