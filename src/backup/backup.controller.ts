import { Body, Controller, Delete, Get, Param, Post, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { AuthService } from '../auth/auth.service';
import { BackupService } from './backup.service';
import { ToolInstallerService } from './tool-installer.service';

@Controller('api')
export class BackupController {
  constructor(private readonly backups: BackupService, private readonly auth: AuthService, private readonly tools: ToolInstallerService) {}
  @Get('dependencies/status') async dependencyStatus(@Req() req: FastifyRequest) { this.auth.requireSession(req); return { ...(await this.backups.dependencyDiagnostics()), installer: this.tools.availablePackages() }; }
  @Get('dependencies') dependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return { status: this.backups.dependencyStatus(), installer: this.tools.availablePackages() }; }
  @Post('dependencies/install') installDependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.tools.startInstall(); }
  @Post('dependencies/repair') repairDependencies(@Req() req: FastifyRequest) { this.auth.requireAdmin(req); return this.tools.repair(); }
  @Get('dependencies/install/:id') dependencyInstallStatus(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.tools.status(id); }
  @Get('connections') connections(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.listConnectionsPage(query); }
@Post('connections') saveConnection(@Req() req: FastifyRequest, @Body() body: any) { this.auth.requireAdmin(req); return this.backups.saveConnection(body); }
@Post('connections/test') testConnection(@Req() req: FastifyRequest, @Body() body: any) { this.auth.requireAdmin(req); return this.backups.testConnection(body); }
  @Get('connections/:id/databases') databases(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.listAvailableDatabases(id); }
  @Delete('connections/:id') deleteConnection(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.deleteConnection(id); }
  @Get('jobs') jobs(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.listJobsPage(query); }
  @Post('jobs') saveJob(@Req() req: FastifyRequest, @Body() body: any) { this.auth.requireAdmin(req); return this.backups.saveJob(body); }
  @Get('jobs/:id/runs') jobRuns(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.runsForJobPage(id, query); }
  @Delete('jobs/:id') deleteJob(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireAdmin(req); return this.backups.deleteJob(id); }
  @Post('jobs/:id/run') run(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req, true); return this.backups.runNow(id); }
  @Get('processes') processes(@Req() req: FastifyRequest) { this.auth.requireSession(req); return this.backups.liveProcesses(); }
  @Get('runs') runs(@Req() req: FastifyRequest) { this.auth.requireSession(req); const query = (req as any).query || {}; return this.backups.runsPage(query); }
  @Get('runs/:id/download') async download(@Req() req: FastifyRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    this.auth.requireSession(req);
    const result = await this.backups.downloadRun(id);
    const filename = result.filename.replace(/["\r\n]/g, '_');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.type('application/octet-stream');
    const stream = fs.createReadStream(result.path);
    if (result.cleanup) stream.once('close', () => { try { fs.rmSync(result.path, { force: true }); fs.rmSync(result.path.replace(/[\\/][^\\/]+$/, ''), { recursive: true, force: true }); } catch {} });
    return reply.send(stream);
  }
  @Post('runs/:id/restore') restore(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: any) { this.auth.requireAdmin(req); return this.backups.restoreRun(id, body); }
  @Post('runs/:id/retry') retry(@Req() req: FastifyRequest, @Param('id') id: string) { this.auth.requireSession(req, true); return this.backups.retryRun(id); }
}
