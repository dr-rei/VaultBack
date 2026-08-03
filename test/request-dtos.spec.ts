import { ValidationPipe } from '@nestjs/common';
import { CredentialsDto } from '../src/common/request-dtos';

describe('global request validation contract', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });

  it('rejects unknown request fields', async () => {
    await expect(pipe.transform(
      { username: 'admin', password: 'secret', unexpected: true },
      { type: 'body', metatype: CredentialsDto, data: '' }
    )).rejects.toThrow();
  });

  it('accepts a valid credentials payload', async () => {
    const value = await pipe.transform(
      { username: 'admin', password: 'secret' },
      { type: 'body', metatype: CredentialsDto, data: '' }
    );
    expect(value).toBeInstanceOf(CredentialsDto);
    expect(value.username).toBe('admin');
  });
});
