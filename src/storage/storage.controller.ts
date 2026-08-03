import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import { StorageService } from './storage.service';
import { StorageTargetDto } from '../common/request-dtos';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrorResponses, ApiExampleResponse } from '../common/swagger-responses';

@Controller('api/storage')
@ApiTags('Storage targets')
@ApiCookieAuth('vb_session')
@ApiCommonErrorResponses()
export class StorageController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}
  @Get()
  @ApiOperation({ summary: 'List storage targets with search and pagination.' })
  @ApiExampleResponse(200, 'Paginated storage targets. Secret configuration values are omitted.', { items: [{ id: 'storage_01HXYZ123', name: 'Nightly off-site archive', type: 'local', createdAt: '2026-08-03T07:00:00.000Z' }], total: 1, page: 1, pageSize: 25, pageCount: 1 })
  list(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.storage.listPage((req as any).query || {}); }
  @Post()
  @ApiOperation({ summary: 'Create or update an encrypted storage target.' })
  @ApiExampleResponse(201, 'Storage target saved. Secrets are encrypted and omitted from the response.', { id: 'storage_01HXYZ123', name: 'Nightly off-site archive', type: 'local', createdAt: '2026-08-03T07:00:00.000Z' })
  save(@Req() req: FastifyRequest, @Body() body: StorageTargetDto) { this.auth.requireAdmin(req); return this.storage.save(body); }
  @Post(':id/test')
  @ApiParam({ name: 'id', description: 'Storage target ID.' })
  @ApiOperation({ summary: 'Test connectivity to a storage target.' })
  @ApiExampleResponse(201, 'Storage connectivity test result.', { ok: true, message: 'Storage connection successful' })
  async test(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.test(this.storage.get(id)); }
  @Get('health')
  @ApiOperation({ summary: 'Read the health summary for all storage targets.' })
  @ApiExampleResponse(200, 'Storage health summary.', [{ id: 'storage_01HXYZ123', name: 'Nightly off-site archive', type: 'local', status: 'healthy', checkedAt: '2026-08-03T07:30:00.000Z', message: 'Storage is available' }])
  healthSummary(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.storage.healthSummary(); }
  @Post(':id/health')
  @ApiParam({ name: 'id', description: 'Storage target ID.' })
  @ApiOperation({ summary: 'Run a health check for one storage target.' })
  @ApiExampleResponse(201, 'Storage health check result.', { id: 'storage_01HXYZ123', name: 'Nightly off-site archive', type: 'local', status: 'healthy', checkedAt: '2026-08-03T07:30:00.000Z', message: 'Storage is available' })
  async health(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.health(this.storage.get(id)); }
  @Delete(':id')
  @ApiParam({ name: 'id', description: 'Storage target ID.' })
  @ApiOperation({ summary: 'Delete a storage target.' })
  @ApiExampleResponse(200, 'Storage target deleted.', { ok: true })
  delete(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.storage.delete(id); }
}
