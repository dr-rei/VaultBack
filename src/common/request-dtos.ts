import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CredentialsDto {
  @ApiProperty({ description: 'Account username.', example: 'admin' })
  @IsString() @IsNotEmpty() @MaxLength(128) username!: string;
  @ApiProperty({ description: 'Account password.', example: 'change-this-password', minLength: 1, maxLength: 512, format: 'password' })
  @IsString() @MinLength(1) @MaxLength(512) password!: string;
}

export class UserDto {
  @ApiPropertyOptional({ description: 'Username. Required when creating a user; omit to keep the current value during an update.', example: 'operator-one' })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) username?: string;
  @ApiPropertyOptional({ description: 'Password. Required when creating a user; omit to keep the current value during an update.', example: 'change-this-password', minLength: 1, maxLength: 512, format: 'password' })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(512) password?: string;
  @ApiPropertyOptional({ description: 'Permission role assigned to the user.', enum: ['admin', 'operator', 'viewer'], example: 'operator', default: 'operator' })
  @IsOptional() @IsIn(['admin', 'operator', 'viewer']) role?: string;
}

export class DatabaseConnectionDto {
  @ApiPropertyOptional({ description: 'Existing connection ID. Omit when creating a connection.', example: 'conn_01HXYZ123' })
  @IsOptional() @IsString() @MaxLength(128) id?: string;
  @ApiProperty({ description: 'Friendly name shown in the VaultBack interface.', example: 'Production MySQL' })
  @IsString() @IsNotEmpty() @MaxLength(128) name!: string;
  @ApiPropertyOptional({ description: 'Database client engine.', enum: ['mysql', 'mariadb'], example: 'mysql', default: 'mysql' })
  @IsOptional() @IsIn(['mysql', 'mariadb']) engine?: 'mysql' | 'mariadb';
  @ApiProperty({ description: 'Database server hostname or IP address.', example: '127.0.0.1' })
  @IsString() @IsNotEmpty() @MaxLength(255) host!: string;
  @ApiPropertyOptional({ description: 'Database server TCP port.', example: 3306, default: 3306, minimum: 1, maximum: 65535 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number;
  @ApiProperty({ description: 'Database account username.', example: 'backup_user' })
  @IsString() @IsNotEmpty() @MaxLength(128) username!: string;
  @ApiPropertyOptional({ description: 'Database account password. Omit for passwordless accounts.', example: 'database-password', format: 'password' })
  @IsOptional() @IsString() @MaxLength(512) password?: string;
  @ApiPropertyOptional({ description: 'Optional default database name. Leave empty to discover databases during a backup.', example: 'application_db' })
  @IsOptional() @IsString() @MaxLength(5000) database?: string;
  @ApiPropertyOptional({ description: 'Enable TLS for the database connection.', example: false, default: false })
  @IsOptional() @IsBoolean() ssl?: boolean;
}

export class StorageTargetDto {
  @ApiPropertyOptional({ description: 'Existing storage target ID. Omit when creating a target.', example: 'storage_01HXYZ123' })
  @IsOptional() @IsString() @MaxLength(128) id?: string;
  @ApiProperty({ description: 'Friendly storage target name.', example: 'Nightly off-site archive' })
  @IsString() @IsNotEmpty() @MaxLength(128) name!: string;
  @ApiProperty({ description: 'Storage provider type. S3-compatible targets can require provider-enforced Object Lock.', enum: ['local', 'ftp', 'webdav', 'google-drive', 'onedrive', 's3'], example: 'local' })
  @IsIn(['local', 'ftp', 'webdav', 'google-drive', 'onedrive', 's3']) type!: 'local' | 'ftp' | 'webdav' | 'google-drive' | 'onedrive' | 's3';
  @ApiProperty({ description: 'Provider-specific configuration. Secrets are encrypted before storage.', type: 'object', additionalProperties: true, example: { directory: './data/backups' } })
  @IsObject() config!: Record<string, unknown>;
}

export class BackupObjectDto {
  @ApiPropertyOptional({ description: 'Include database views in the database objects file.', example: true, default: false })
  @IsOptional() @IsBoolean() views?: boolean;
  @ApiPropertyOptional({ description: 'Include stored procedures and functions.', example: true, default: false })
  @IsOptional() @IsBoolean() routines?: boolean;
  @ApiPropertyOptional({ description: 'Include triggers with table definitions.', example: true, default: false })
  @IsOptional() @IsBoolean() triggers?: boolean;
  @ApiPropertyOptional({ description: 'Include scheduled database events.', example: true, default: false })
  @IsOptional() @IsBoolean() events?: boolean;
}

export class DatabaseSelectionDto {
  @ApiProperty({ description: 'Connection ID that owns the selected databases.', example: 'conn_01HXYZ123' })
  @IsString() @IsNotEmpty() @MaxLength(128) connectionId!: string;
  @ApiProperty({ description: 'Database names to back up from this connection.', example: ['application_db', 'reporting_db'], type: [String] })
  @IsArray() @IsString({ each: true }) @MaxLength(5000, { each: true }) databases!: string[];
}

export class BackupJobDto {
  @ApiPropertyOptional({ description: 'Existing schedule ID. Omit when creating a schedule.', example: 'job_01HXYZ123' })
  @IsOptional() @IsString() @MaxLength(128) id?: string;
  @ApiProperty({ description: 'Schedule display name.', example: 'Nightly production backup' })
  @IsString() @IsNotEmpty() @MaxLength(128) name!: string;
  @ApiPropertyOptional({ description: 'Legacy single database connection ID. Prefer connectionIds for new schedules.', example: 'conn_01HXYZ123' })
  @IsOptional() @IsString() @MaxLength(128) databaseConnectionId?: string;
  @ApiPropertyOptional({ description: 'Database connections included in this schedule.', example: ['conn_01HXYZ123', 'conn_01HXYZ456'], type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) connectionIds?: string[];
  @ApiPropertyOptional({ description: 'Legacy alias for connectionIds.', example: ['conn_01HXYZ123'], type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) databaseConnectionIds?: string[];
  @ApiPropertyOptional({ description: 'Legacy single storage target ID. Prefer storageTargetIds for new schedules.', example: 'storage_01HXYZ123' })
  @IsOptional() @IsString() @MaxLength(128) storageTargetId?: string;
  @ApiPropertyOptional({ description: 'Storage targets that receive each completed backup.', example: ['storage_01HXYZ123', 'storage_01HXYZ456'], type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) storageTargetIds?: string[];
  @ApiPropertyOptional({ description: 'Back up every visible database or only the selected database names.', enum: ['all', 'selected'], example: 'all', default: 'all' })
  @IsOptional() @IsIn(['all', 'selected']) databaseScope?: 'all' | 'selected';
  @ApiPropertyOptional({ description: 'Legacy selected database names.', example: ['application_db'], type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) databases?: string[];
  @ApiPropertyOptional({ description: 'Selected databases grouped by their connection.', type: () => [DatabaseSelectionDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DatabaseSelectionDto) databaseSelections?: DatabaseSelectionDto[];
  @ApiPropertyOptional({ description: 'Archive layout.', enum: ['single', 'database', 'table'], example: 'single', default: 'single' })
  @IsOptional() @IsIn(['single', 'database', 'table']) backupLayout?: 'single' | 'database' | 'table';
  @ApiPropertyOptional({ description: 'Optional database object types included in the backup.', type: () => BackupObjectDto })
  @IsOptional() @ValidateNested() @Type(() => BackupObjectDto) backupObjects?: BackupObjectDto;
  @ApiProperty({ description: 'Cron expression used to schedule the backup.', example: '0 2 * * *' })
  @IsString() @IsNotEmpty() @MaxLength(128) cronExpression!: string;
  @ApiPropertyOptional({ description: 'IANA timezone used to interpret the cron expression.', example: 'Asia/Jakarta', default: 'UTC' })
  @IsOptional() @IsString() @MaxLength(128) timezone?: string;
  @ApiPropertyOptional({ description: 'Whether the schedule is active.', example: true, default: true })
  @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ description: 'Compression format for the backup archive.', enum: ['none', 'gzip', 'zip'], example: 'gzip', default: 'gzip' })
  @IsOptional() @IsIn(['none', 'gzip', 'zip']) compression?: 'none' | 'gzip' | 'zip';
  @ApiPropertyOptional({ description: 'Encryption applied to the completed backup archive.', enum: ['none', 'aes-256-gcm'], example: 'none', default: 'none' })
  @IsOptional() @IsIn(['none', 'aes-256-gcm']) backupEncryption?: 'none' | 'aes-256-gcm';
  @ApiPropertyOptional({ description: 'Number of completed backups retained for this schedule.', example: 7, default: 7, minimum: 1, maximum: 365 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) retentionCount?: number;
  @ApiPropertyOptional({ description: 'Number of automatic retries after a failed backup.', example: 2, default: 0, minimum: 0, maximum: 10 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) retryCount?: number;
  @ApiPropertyOptional({ description: 'Delay between retries in seconds.', example: 300, default: 300, minimum: 30, maximum: 86400 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(30) @Max(86400) retryDelaySeconds?: number;
  @ApiPropertyOptional({ description: 'Behavior when a previous run is still active.', enum: ['skip', 'queue'], example: 'skip', default: 'skip' })
  @IsOptional() @IsIn(['skip', 'queue']) overlapPolicy?: 'skip' | 'queue';
  @ApiPropertyOptional({ description: 'Prefix used for generated archive filenames.', example: 'production-backup' })
  @IsOptional() @IsString() @MaxLength(128) filenamePrefix?: string;
  @ApiPropertyOptional({ description: 'Internal last-run timestamp. Normally managed by the server.', example: '2026-08-03T02:00:00.000Z', readOnly: true })
  @IsOptional() @IsString() @MaxLength(64) lastRunAt?: string;
}

export class RestoreDto {
  @ApiProperty({ description: 'Destination database connection ID.', example: 'conn_01HXYZ123' })
  @IsString() @IsNotEmpty() @MaxLength(128) connectionId!: string;
  @ApiProperty({ description: 'Restore into the original database or create a new database name.', enum: ['overwrite', 'new'], example: 'new' })
  @IsIn(['overwrite', 'new']) mode!: string;
  @ApiPropertyOptional({ description: 'Required when mode is new; the destination database name.', example: 'application_db_restored' })
  @IsOptional() @IsString() @MaxLength(64) databaseName?: string;
  @ApiProperty({ description: 'Must be true to confirm an overwrite when mode is overwrite.', example: false })
  @IsBoolean() overwriteConfirmed!: boolean;
  @ApiPropertyOptional({ description: 'Verify the restored database after import.', example: true, default: true })
  @IsOptional() @IsBoolean() verifyAfterRestore?: boolean;
}

export class EnvironmentDto {
  @ApiProperty({ description: 'Runtime protection mode.', enum: ['development', 'production'], example: 'production' })
  @IsIn(['development', 'production']) environment!: string;
  @ApiPropertyOptional({ description: 'Request the configured supervisor to restart after saving.', example: true, default: false })
  @IsOptional() @IsBoolean() restart?: boolean;
}

export class NotificationEventsDto {
  @ApiPropertyOptional({ description: 'Notify when a backup succeeds.', example: true })
  @IsOptional() @IsBoolean() backup_success?: boolean;
  @ApiPropertyOptional({ description: 'Notify when a backup fails.', example: true })
  @IsOptional() @IsBoolean() backup_failed?: boolean;
  @ApiPropertyOptional({ description: 'Notify when a backup is retried.', example: true })
  @IsOptional() @IsBoolean() backup_retry?: boolean;
  @ApiPropertyOptional({ description: 'Notify when a backup is stale.', example: false })
  @IsOptional() @IsBoolean() backup_stale?: boolean;
  @ApiPropertyOptional({ description: 'Notify when a storage target fails.', example: true })
  @IsOptional() @IsBoolean() storage_failed?: boolean;
  @ApiPropertyOptional({ description: 'Notify when application capacity is low.', example: true })
  @IsOptional() @IsBoolean() capacity_warning?: boolean;
}

export class NotificationDto {
  @ApiPropertyOptional({ description: 'Enable outbound notifications.', example: true })
  @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ description: 'Notification provider.', enum: ['discord', 'telegram', 'generic'], example: 'discord' })
  @IsOptional() @IsIn(['discord', 'telegram', 'generic']) provider?: string;
  @ApiPropertyOptional({ description: 'Webhook URL for Discord or a generic webhook provider.', example: 'https://example.invalid/webhook' })
  @IsOptional() @IsString() @MaxLength(2000) webhookUrl?: string;
  @ApiPropertyOptional({ description: 'Webhook authentication token.', example: 'webhook-token', format: 'password' })
  @IsOptional() @IsString() @MaxLength(512) webhookToken?: string;
  @ApiPropertyOptional({ description: 'Telegram bot token.', example: '123456:bot-token', format: 'password' })
  @IsOptional() @IsString() @MaxLength(512) botToken?: string;
  @ApiPropertyOptional({ description: 'Telegram chat ID.', example: '-1001234567890' })
  @IsOptional() @IsString() @MaxLength(128) chatId?: string;
  @ApiPropertyOptional({ description: 'Event notification switches.', type: () => NotificationEventsDto })
  @IsOptional() @ValidateNested() @Type(() => NotificationEventsDto) events?: NotificationEventsDto;
}

export class FullExportDto {
  @ApiProperty({ description: 'Password used to encrypt the full configuration export.', example: 'migration-password', minLength: 1, maxLength: 512, format: 'password' })
  @IsString() @MinLength(1) @MaxLength(512) password!: string;
}

export class FullImportDto {
  @ApiProperty({ description: 'Encrypted configuration package previously produced by the full export endpoint.', type: 'object', additionalProperties: true, example: { version: 1, ciphertext: 'base64-encoded-data' } })
  @IsObject() package!: Record<string, unknown>;
  @ApiProperty({ description: 'Password used to decrypt the imported configuration package.', example: 'migration-password', minLength: 1, maxLength: 512, format: 'password' })
  @IsString() @MinLength(1) @MaxLength(512) password!: string;
}

export class RecoveryPlanDto {
  @ApiPropertyOptional({ description: 'Existing recovery plan ID. Omit when creating a plan.', example: 'recovery_plan_01HXYZ123' })
  @IsOptional() @IsString() @MaxLength(128) id?: string;
  @ApiProperty({ description: 'Name shown in the Recovery Assurance module.', example: 'Weekly production restore test' })
  @IsString() @IsNotEmpty() @MaxLength(128) name!: string;
  @ApiProperty({ description: 'Schedule whose latest successful artifact will be tested.', example: 'job_01HXYZ123' })
  @IsString() @IsNotEmpty() @MaxLength(128) jobId!: string;
  @ApiProperty({ description: 'Database connection used only as the isolated restore destination.', example: 'conn_01HXYZ456' })
  @IsString() @IsNotEmpty() @MaxLength(128) destinationConnectionId!: string;
  @ApiPropertyOptional({ description: 'Five-field cron expression for the restore test.', example: '0 4 * * 0', default: '0 4 * * 0' })
  @IsOptional() @IsString() @MaxLength(128) cronExpression?: string;
  @ApiPropertyOptional({ description: 'IANA timezone for the restore-test schedule.', example: 'Asia/Jakarta', default: 'UTC' })
  @IsOptional() @IsString() @MaxLength(128) timezone?: string;
  @ApiPropertyOptional({ description: 'Enable the scheduled restore test.', example: true, default: true })
  @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ description: 'Prefix for generated disposable database names.', example: 'vaultback_recovery_test' })
  @IsOptional() @IsString() @MaxLength(48) testDatabasePrefix?: string;
}

export class PitrCaptureDto {
  @ApiProperty({ description: 'Database connection whose raw binary logs should be captured.', example: 'conn_01HXYZ123' })
  @IsString() @IsNotEmpty() @MaxLength(128) connectionId!: string;
  @ApiProperty({ description: 'Storage target where the raw binary log files will be uploaded.', example: 'storage_01HXYZ123' })
  @IsString() @IsNotEmpty() @MaxLength(128) storageTargetId!: string;
}

export class FleetEnrollmentDto {
  @ApiProperty({ description: 'Friendly name for the enrolled VaultBack installation.', example: 'Production backup server' })
  @IsString() @IsNotEmpty() @MaxLength(128) name!: string;
  @ApiProperty({ description: 'Installation identity generated by the server being enrolled.', example: 'install_01HXYZ123' })
  @IsString() @IsNotEmpty() @MaxLength(128) installationId!: string;
  @ApiProperty({ description: 'One-time enrollment token. It is hashed and never returned after enrollment.', example: 'one-time-enrollment-token', minLength: 16, maxLength: 512, format: 'password' })
  @IsString() @MinLength(16) @MaxLength(512) token!: string;
}
