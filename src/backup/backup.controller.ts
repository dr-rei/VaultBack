import { Body, Controller, Delete, Get, Param, Post, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { AuthService } from '../auth/auth.service';
import { BackupService } from './backup.service';
import { ToolInstallerService } from './tool-installer.service';
import { BackupJobDto, DatabaseConnectionDto, RestoreDto } from '../common/request-dtos';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiAcceptedExample, ApiCommonErrorResponses, ApiExampleResponse, ApiFileResponse } from '../common/swagger-responses';
import { SystemService } from '../system/system.service';

@Controller('api')
@ApiTags('Backups, schedules, and database connections')
@ApiCookieAuth('vb_session')
@ApiCommonErrorResponses()
export class BackupController {
  constructor(private readonly backups: BackupService, private readonly auth: AuthService, private readonly tools: ToolInstallerService, private readonly system: SystemService) {}
  @Get('dependencies/status')
  @ApiOperation({ summary: 'Check bundled database tool health and availability.' })
  @ApiExampleResponse(200, 'Bundled database tool diagnostics.', { ok: true, engines: [{ engine: 'mysql', client: { available: true, command: 'mysql' }, dump: { available: true, command: 'mysqldump' } }], checkedAt: '2026-08-03T07:30:00.000Z', installer: { supported: true, packages: [] } })
  async dependencyStatus(@Req() req: FastifyRequest) { this.auth.requireSession(req); return { ...(await this.backups.dependencyDiagnostics()), installer: this.tools.availablePackages() }; }
  @Get('dependencies')
  @ApiOperation({ summary: 'Read detailed database tool status. Administrator only.' })
  @ApiExampleResponse(200, 'Detailed bundled tool status.', { status: { ok: true, engines: [{ engine: 'mysql', client: { available: true, command: 'mysql' }, dump: { available: true, command: 'mysqldump' } }] }, installer: { supported: true, packages: [] } })
  dependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return { status: this.backups.dependencyStatus(), installer: this.tools.availablePackages() }; }
  @Post('dependencies/install')
  @ApiOperation({ summary: 'Start installation of missing bundled database tools.' })
  @ApiExampleResponse(201, 'Tool installation job queued.', { id: 'install_01HXYZ123', package: 'mariadb', version: '11.8.6', state: 'queued', message: 'Preparing the official database tool package', bytesDownloaded: 0, totalBytes: null, percent: 0, startedAt: '2026-08-03T07:30:00.000Z', updatedAt: '2026-08-03T07:30:00.000Z' })
  installDependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.tools.startInstall(); }
  @Post('dependencies/repair')
  @ApiOperation({ summary: 'Repair bundled database tools by replacing the managed files.' })
  @ApiExampleResponse(201, 'Tool repair job queued.', { id: 'install_01HXYZ123', package: 'mariadb', version: '11.8.6', state: 'queued', repair: true, removed: true, percent: 0 })
  repairDependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.tools.repair(); }
  @Get('dependencies/install/:id')
  @ApiParam({ name: 'id', description: 'Tool installation job ID.' })
  @ApiOperation({ summary: 'Read the status of a tool installation job.' })
  @ApiExampleResponse(200, 'Tool installation progress.', { id: 'install_01HXYZ123', package: 'mariadb', version: '11.8.6', state: 'downloading', message: 'Downloading the official MariaDB client package', bytesDownloaded: 33554432, totalBytes: 92274688, percent: 36, startedAt: '2026-08-03T07:30:00.000Z', updatedAt: '2026-08-03T07:30:08.000Z' })
  dependencyInstallStatus(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.tools.status(id); }
  @Get('connections')
  @ApiOperation({ summary: 'List database connections with search and pagination.' })
  @ApiExampleResponse(200, 'Paginated database connections. Passwords are never returned.', { items: [{ id: 'conn_01HXYZ123', name: 'Production MySQL', engine: 'mysql', host: '127.0.0.1', port: 3306, username: 'backup_user', database: 'application_db', databaseScope: 'selected', databases: ['application_db'], ssl: false, createdAt: '2026-08-03T07:00:00.000Z' }], total: 1, page: 1, pageSize: 25, pageCount: 1 })
  connections(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.listConnectionsPage(query); }
  @Post('connections')
  @ApiOperation({ summary: 'Create or update an encrypted database connection.' })
  @ApiExampleResponse(201, 'Database connection saved. The password is encrypted and omitted from the response.', { id: 'conn_01HXYZ123', name: 'Production MySQL', engine: 'mysql', host: '127.0.0.1', port: 3306, username: 'backup_user', database: 'application_db', databaseScope: 'selected', databases: ['application_db'], ssl: false, createdAt: '2026-08-03T07:00:00.000Z' })
  saveConnection(@Req() req: FastifyRequest, @Body() body: DatabaseConnectionDto) { this.auth.requireAdmin(req); return this.backups.saveConnection(body); }
  @Post('connections/test')
  @ApiOperation({ summary: 'Test database credentials before saving them.' })
  @ApiExampleResponse(201, 'Connection test result.', { ok: true, message: 'Database connection successful' })
  testConnection(@Req() req: FastifyRequest, @Body() body: DatabaseConnectionDto) { this.auth.requireAdmin(req); return this.backups.testConnection(body); }
  @Get('connections/:id/databases')
  @ApiParam({ name: 'id', description: 'Database connection ID.' })
  @ApiOperation({ summary: 'Discover databases visible to a connection.' })
  @ApiExampleResponse(200, 'Databases visible to the configured account.', { databases: ['application_db', 'reporting_db'] })
  databases(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.listAvailableDatabases(id); }
  @Delete('connections/:id')
  @ApiParam({ name: 'id', description: 'Database connection ID.' })
  @ApiOperation({ summary: 'Delete a database connection.' })
  @ApiExampleResponse(200, 'Database connection deleted.', { ok: true })
  deleteConnection(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.deleteConnection(id); }
  @Get('jobs')
  @ApiOperation({ summary: 'List backup schedules with search and pagination.' })
  @ApiExampleResponse(200, 'Paginated backup schedules.', { items: [{ id: 'job_01HXYZ123', name: 'Nightly production backup', databaseConnectionId: 'conn_01HXYZ123', storageTargetId: 'storage_01HXYZ123', databaseScope: 'selected', databases: ['application_db'], databaseLayout: 'single', backupLayout: 'single', backupObjects: { views: true, routines: true, triggers: true, events: true }, cronExpression: '0 2 * * *', timezone: 'Asia/Jakarta', enabled: true, compression: 'gzip', backupEncryption: 'none', retentionCount: 7, retryCount: 2, retryDelaySeconds: 300, overlapPolicy: 'skip', filenamePrefix: 'production-backup', nextRunAt: '2026-08-04T19:00:00.000Z', lastRunAt: null, createdAt: '2026-08-03T07:00:00.000Z', databaseConnectionIds: ['conn_01HXYZ123'], storageTargetIds: ['storage_01HXYZ123'], databaseSelections: [{ connectionId: 'conn_01HXYZ123', databases: ['application_db'] }] }], total: 1, page: 1, pageSize: 25, pageCount: 1, activeTotal: 1 })
  jobs(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.listJobsPageV2(query); }
  @Post('jobs')
  @ApiOperation({ summary: 'Create or update a backup schedule.' })
  @ApiExampleResponse(201, 'Backup schedule saved.', { id: 'job_01HXYZ123', name: 'Nightly production backup', databaseConnectionIds: ['conn_01HXYZ123'], storageTargetIds: ['storage_01HXYZ123'], databaseScope: 'selected', databaseSelections: [{ connectionId: 'conn_01HXYZ123', databases: ['application_db'] }], backupLayout: 'single', compression: 'gzip', enabled: true, cronExpression: '0 2 * * *', timezone: 'Asia/Jakarta', nextRunAt: '2026-08-04T19:00:00.000Z' })
  saveJob(@Req() req: FastifyRequest, @Body() body: BackupJobDto) { this.auth.requireAdmin(req); return this.backups.saveJobV2(body); }
  @Get('jobs/:id/runs')
  @ApiParam({ name: 'id', description: 'Backup schedule ID.' })
  @ApiOperation({ summary: 'List completed and failed runs for one schedule.' })
  @ApiExampleResponse(200, 'Paginated downloadable successful backups for the schedule.', { items: [{ id: 'run_01HXYZ123', jobId: 'job_01HXYZ123', jobName: 'Nightly production backup', status: 'success', startedAt: '2026-08-03T19:00:00.000Z', finishedAt: '2026-08-03T19:00:38.000Z', filename: 'production-backup-2026-08-03.sql.gz', storageTargetName: 'Local archive', sizeBytes: 345200000, sha256: 'sha256-hash', verificationStatus: 'passed', databases: ['application_db'] }], total: 1, page: 1, pageSize: 25, pageCount: 1 })
  jobRuns(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.runsForJobPage(id, query); }
  @Delete('jobs/:id')
  @ApiParam({ name: 'id', description: 'Backup schedule ID.' })
  @ApiOperation({ summary: 'Delete a backup schedule.' })
  @ApiExampleResponse(200, 'Backup schedule deleted.', { ok: true })
  deleteJob(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.deleteJob(id); }
  @Post('jobs/:id/run')
  @ApiParam({ name: 'id', description: 'Backup schedule ID.' })
  @ApiOperation({ summary: 'Run a backup schedule immediately.' })
  @ApiExampleResponse(201, 'Backup run started.', { id: 'run_01HXYZ123', jobId: 'job_01HXYZ123', status: 'running', startedAt: '2026-08-03T07:30:00.000Z' })
  run(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req, true); return this.backups.runNow(id); }
  @Get('processes')
  @ApiOperation({ summary: 'List live and recently completed backup processes.' })
  @ApiExampleResponse(200, 'Live and recent process state.', { items: [{ id: 'run_01HXYZ123', jobId: 'job_01HXYZ123', jobName: 'Nightly production backup', status: 'running', stage: 'dumping', startedAt: '2026-08-03T07:30:00.000Z', updatedAt: '2026-08-03T07:30:08.000Z', logs: ['Backup started', 'Dumping selected databases'] }], updatedAt: '2026-08-03T07:30:08.000Z' })
  processes(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.backups.liveProcesses(); }
  @Get('runs')
  @ApiOperation({ summary: 'List backup history with search and pagination.' })
  @ApiExampleResponse(200, 'Paginated backup history with unresolved failure count.', { items: [{ id: 'run_01HXYZ123', jobId: 'job_01HXYZ123', jobName: 'Nightly production backup', status: 'success', startedAt: '2026-08-03T02:00:00.000Z', finishedAt: '2026-08-03T02:00:38.000Z', filename: 'production-backup-2026-08-03.sql.gz', sizeBytes: 345200000, verificationStatus: 'passed', databases: ['application_db'] }], total: 1, page: 1, pageSize: 25, pageCount: 1, successTotal: 1, failedTotal: 2, attentionTotal: 0 })
  runs(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.runsPage(query); }
  @Post('runs/reconcile')
  @ApiOperation({ summary: 'Reconcile historical backup records with their storage files. Administrator only.' })
  @ApiExampleResponse(201, 'Historical backup reconciliation completed.', { ok: true, checked: 42, expired: 17, available: 24, errors: 1, errorItems: [], completedAt: '2026-08-18T03:00:00.000Z' })
  async reconcileRuns(@Req() req: FastifyRequest) { const session = this.auth.requireAdmin(req); const result = await this.backups.reconcileMissingArtifacts(); this.system.audit(session.user_id, 'backup.artifacts.reconcile', undefined, undefined, { checked: result.checked, expired: result.expired, errors: result.errors }); return result; }
  @Post('runs/:id/download/prepare')
  @ApiParam({ name: 'id', description: 'Backup run ID.' })
  @ApiOperation({ summary: 'Prepare a backup download and report progress.' })
  @ApiExampleResponse(201, 'Download preparation started.', { id: 'download_01HXYZ123', runId: 'run_01HXYZ123', filename: 'production-backup-2026-08-03.sql.gz', state: 'preparing', percent: 0, stage: 'checking', message: 'Checking backup availability', updatedAt: 1754206200000 })
  prepareDownload(@Req() req: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireSession(req); return this.backups.startDownloadPreparation(id, session.user_id); }
  @Get('downloads/:id/status')
  @ApiParam({ name: 'id', description: 'Download preparation ID.' })
  @ApiOperation({ summary: 'Read backup download preparation progress.' })
  @ApiExampleResponse(200, 'Download preparation progress.', { id: 'download_01HXYZ123', runId: 'run_01HXYZ123', filename: 'production-backup-2026-08-03.sql.gz', state: 'ready', percent: 100, stage: 'ready', message: 'Ready to download', updatedAt: 1754206230000 })
  downloadStatus(@Req() req: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireSession(req); return this.backups.getDownloadPreparation(id, session.user_id); }
  @Get('downloads/:id/file')
  @ApiParam({ name: 'id', description: 'Download preparation ID.' })
  @ApiOperation({ summary: 'Download a prepared backup archive.' })
  @ApiFileResponse('Prepared backup archive.')
  async preparedDownload(@Req() req: FastifyRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    const session = this.auth.requireSession(req);
    const result = this.backups.takePreparedDownload(id, session.user_id);
    const filename = result.filename.replace(/["\r\n]/g, '_');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.type('application/octet-stream');
    const stream = fs.createReadStream(result.path);
    if (result.cleanup) stream.once('close', () => { try { fs.rmSync(result.path, { force: true }); fs.rmSync(result.path.replace(/[\\/][^\\/]+$/, ''), { recursive: true, force: true }); } catch {} });
    return reply.send(stream);
  }
  @Get('runs/:id/download')
  @ApiParam({ name: 'id', description: 'Backup run ID.' })
  @ApiOperation({ summary: 'Download a completed backup archive.' })
  @ApiFileResponse('Completed backup archive.')
  async download(@Req() req: FastifyRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    this.auth.requireSession(req);
    const result = await this.backups.downloadRun(id);
    const filename = result.filename.replace(/["\r\n]/g, '_');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.type('application/octet-stream');
    const stream = fs.createReadStream(result.path);
    if (result.cleanup) stream.once('close', () => { try { fs.rmSync(result.path, { force: true }); fs.rmSync(result.path.replace(/[\\/][^\\/]+$/, ''), { recursive: true, force: true }); } catch {} });
    return reply.send(stream);
  }
  @Post('runs/:id/restore')
  @ApiParam({ name: 'id', description: 'Backup run ID.' })
  @ApiOperation({ summary: 'Restore a backup into an existing or new database.' })
  @ApiExampleResponse(201, 'Restore completed.', { ok: true, mode: 'new', database: 'application_db_restored', verified: true, message: 'Backup restored successfully' })
  restore(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: RestoreDto) { this.auth.requireAdmin(req); return this.backups.restoreRun(id, body); }
  @Post('runs/:id/retry')
  @ApiParam({ name: 'id', description: 'Backup run ID.' })
  @ApiOperation({ summary: 'Retry a failed backup run.' })
  @ApiExampleResponse(201, 'Retry started.', { id: 'run_01HXYZ456', jobId: 'job_01HXYZ123', status: 'running', startedAt: '2026-08-03T07:35:00.000Z' })
  retry(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req, true); return this.backups.retryRun(id); }
  @Get('runs/:id/verification')
  @ApiParam({ name: 'id', description: 'Backup run ID.' })
  @ApiOperation({ summary: 'Read backup verification results.' })
  @ApiExampleResponse(200, 'Backup verification reports.', [{ id: 'verification_01HXYZ123', runId: 'run_01HXYZ123', kind: 'archive', status: 'passed', message: 'Archive contents verified', details: {}, createdAt: '2026-08-03T02:00:38.000Z' }])
  verification(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req); return this.backups.verificationReport(id); }
}
