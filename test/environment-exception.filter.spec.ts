import { EnvironmentExceptionFilter } from '../src/common/environment-exception.filter';

describe('EnvironmentExceptionFilter', () => {
  it('writes a JSON response through a raw Node response', () => {
    const filter = new EnvironmentExceptionFilter(true);
    let body = '';
    const response = {
      statusCode: 0,
      writableEnded: false,
      setHeader: jest.fn(),
      end: jest.fn((value: string) => { body = value; })
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ id: 'req-error', method: 'GET', url: '/broken' }),
        getResponse: () => response
      })
    } as any;

    filter.catch(new Error('private failure'), host);

    expect(response.statusCode).toBe(500);
    expect(response.setHeader).toHaveBeenCalledWith('content-type', 'application/json; charset=utf-8');
    expect(JSON.parse(body)).toEqual(expect.objectContaining({ message: 'Internal server error' }));
  });
});
