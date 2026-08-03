import { Body, Controller, Delete, Get, Param, Post, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { AuthService } from '../auth/auth.service';
import { BackupService } from './backup.service';
import { ToolInstallerService } from './tool-installer.service';
import { BackupJobDto, DatabaseConnectionDto, RestoreDto } from '../common/request-dtos';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

@Controller('api')
@ApiTags('Backups, schedules, and database connections')
@ApiCookieAuth('vb_session')
export class BackupController {
  constructor(private readonly backups: BackupService, private readonly auth: AuthService, private readonly tools: ToolInstallerService) {}
  @Get('dependencies/status')
  @ApiOperation({ summary: 'Check bundled database tool health and availability.' })
  async dependencyStatus(@Req() req: FastifyRequest) { this.auth.requireSession(req); return { ...(await this.backups.dependencyDiagnostics()), installer: this.tools.availablePackages() }; }
  @Get('dependencies')
  @ApiOperation({ summary: 'Read detailed database tool status. Administrator only.' })
  dependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return { status: this.backups.dependencyStatus(), installer: this.tools.availablePackages() }; }
  @Post('dependencies/install')
  @ApiOperation({ summary: 'Start installation of missing bundled database tools.' })
  installDependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.tools.startInstall(); }
  @Post('dependencies/repair')
  @ApiOperation({ summary: 'Repair bundled database tools by replacing the managed files.' })
  repairDependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.tools.repair(); }
  @Get('dependencies/install/:id')
  @ApiParam({ name: 'id', description: 'Tool installation job ID.' })
  @ApiOperation({ summary: 'Read the status of a tool installation job.' })
  dependencyInstallStatus(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.tools.status(id); }
  @Get('connections')
  @ApiOperation({ summary: 'List database connections with search and pagination.' })
  connections(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.listConnectionsPage(query); }
  @Post('connections')
  @ApiOperation({ summary: 'Create or update an encrypted database connection.' })
  saveConnection(@Req() req: FastifyRequest, @Body() body: DatabaseConnectionDto) { this.auth.requireAdmin(req); return this.backups.saveConnection(body); }
  @Post('connections/test')
  @ApiOperation({ summary: 'Test database credentials before saving them.' })
  testConnection(@Req() req: FastifyRequest, @Body() body: DatabaseConnectionDto) { this.auth.requireAdmin(req); return this.backups.testConnection(body); }
  @Get('connections/:id/databases')
  @ApiParam({ name: 'id', description: 'Database connection ID.' })
  @ApiOperation({ summary: 'Discover databases visible to a connection.' })
  databases(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.listAvailableDatabases(id); }
  @Delete('connections/:id')
  @ApiParam({ name: 'id', description: 'Database connection ID.' })
  @ApiOperation({ summary: 'Delete a database connection.' })
  deleteConnection(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.deleteConnection(id); }
  @Get('jobs')
  @ApiOperation({ summary: 'List backup schedules with search and pagination.' })
  jobs(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.listJobsPageV2(query); }
  @Post('jobs')
  @ApiOperation({ summary: 'Create or update a backup schedule.' })
  saveJob(@Req() req: FastifyRequest, @Body() body: BackupJobDto) { this.auth.requireAdmin(req); return this.backups.saveJobV2(body); }
  @Get('jobs/:id/runs')
  @ApiParam({ name: 'id', description: 'Backup schedule ID.' })
  @ApiOperation({ summary: 'List completed and failed runs for one schedule.' })
  jobRuns(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.runsForJobPage(id, query); }
  @Delete('jobs/:id')
  @ApiParam({ name: 'id', description: 'Backup schedule ID.' })
  @ApiOperation({ summary: 'Delete a backup schedule.' })
  deleteJob(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.deleteJob(id); }
  @Post('jobs/:id/run')
  @ApiParam({ name: 'id', description: 'Backup schedule ID.' })
  @ApiOperation({ summary: 'Run a backup schedule immediately.' })
  run(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req, true); return this.backups.runNow(id); }
  @Get('processes')
  @ApiOperation({ summary: 'List live and recently completed backup processes.' })
  processes(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.backups.liveProcesses(); }
  @Get('runs')
  @ApiOperation({ summary: 'List backup history with search and pagination.' })
  runs(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.runsPage(query); }
  @Post('runs/:id/download/prepare')
  @ApiParam({ name: 'id', description: 'Backup run ID.' })
  @ApiOperation({ summary: 'Prepare a backup download and report progress.' })
  prepareDownload(@Req() req: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireSession(req); return this.backups.startDownloadPreparation(id, session.user_id); }
  @Get('downloads/:id/status')
  @ApiParam({ name: 'id', description: 'Download preparation ID.' })
  @ApiOperation({ summary: 'Read backup download preparation progress.' })
  downloadStatus(@Req() req: FastifyRequest, @Param('id') id: string) { const session = this.auth.requireSession(req); return this.backups.getDownloadPreparation(id, session.user_id); }
  @Get('downloads/:id/file')
  @ApiParam({ name: 'id', description: 'Download preparation ID.' })
  @ApiOperation({ summary: 'Download a prepared backup archive.' })
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
  restore(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: RestoreDto) { this.auth.requireAdmin(req); return this.backups.restoreRun(id, body); }
  @Post('runs/:id/retry')
  @ApiParam({ name: 'id', description: 'Backup run ID.' })
  @ApiOperation({ summary: 'Retry a failed backup run.' })
  retry(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req, true); return this.backups.retryRun(id); }
  @Get('runs/:id/verification')
  @ApiParam({ name: 'id', description: 'Backup run ID.' })
  @ApiOperation({ summary: 'Read backup verification results.' })
  verification(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req); return this.backups.verificationReport(id); }
}
