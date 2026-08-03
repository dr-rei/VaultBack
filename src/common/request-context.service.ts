import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

type RequestContext = { requestId: string };

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(requestId: string, callback: () => T) {
    return this.storage.run({ requestId }, callback);
  }

  getRequestId() {
    return this.storage.getStore()?.requestId || '';
  }
}
