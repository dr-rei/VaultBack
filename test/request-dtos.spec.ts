import { ValidationPipe } from '@nestjs/common';
import { BackupJobDto, CredentialsDto } from '../src/common/request-dtos';

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

  it('accepts only supported schedule INSERT styles', async () => {
    const metadata = { type: 'body' as const, metatype: BackupJobDto, data: '' };
    const value = await pipe.transform(
      { name: 'Nightly', cronExpression: '0 2 * * *', insertMode: 'single-row' },
      metadata
    );
    expect(value.insertMode).toBe('single-row');
    await expect(pipe.transform(
      { name: 'Nightly', cronExpression: '0 2 * * *', insertMode: 'batch' },
      metadata
    )).rejects.toThrow();
  });
});
