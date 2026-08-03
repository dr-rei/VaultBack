import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class CredentialsDto {
  @IsString() @IsNotEmpty() @MaxLength(128) username!: string;
  @IsString() @MinLength(1) @MaxLength(512) password!: string;
}

export class UserDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) username?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(512) password?: string;
  @IsOptional() @IsIn(['admin', 'operator', 'viewer']) role?: string;
}

export class DatabaseConnectionDto {
  @IsOptional() @IsString() @MaxLength(128) id?: string;
  @IsString() @IsNotEmpty() @MaxLength(128) name!: string;
  @IsOptional() @IsIn(['mysql', 'mariadb']) engine?: 'mysql' | 'mariadb';
  @IsString() @IsNotEmpty() @MaxLength(255) host!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number;
  @IsString() @IsNotEmpty() @MaxLength(128) username!: string;
  @IsOptional() @IsString() @MaxLength(512) password?: string;
  @IsOptional() @IsString() @MaxLength(5000) database?: string;
  @IsOptional() @IsBoolean() ssl?: boolean;
}

export class StorageTargetDto {
  @IsOptional() @IsString() @MaxLength(128) id?: string;
  @IsString() @IsNotEmpty() @MaxLength(128) name!: string;
  @IsIn(['local', 'ftp', 'webdav', 'google-drive', 'onedrive']) type!: 'local' | 'ftp' | 'webdav' | 'google-drive' | 'onedrive';
  @IsObject() config!: Record<string, unknown>;
}

export class BackupObjectDto {
  @IsOptional() @IsBoolean() views?: boolean;
  @IsOptional() @IsBoolean() routines?: boolean;
  @IsOptional() @IsBoolean() triggers?: boolean;
  @IsOptional() @IsBoolean() events?: boolean;
}

export class DatabaseSelectionDto {
  @IsString() @IsNotEmpty() @MaxLength(128) connectionId!: string;
  @IsArray() @IsString({ each: true }) @MaxLength(5000, { each: true }) databases!: string[];
}

export class BackupJobDto {
  @IsOptional() @IsString() @MaxLength(128) id?: string;
  @IsString() @IsNotEmpty() @MaxLength(128) name!: string;
  @IsOptional() @IsString() @MaxLength(128) databaseConnectionId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) connectionIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) databaseConnectionIds?: string[];
  @IsOptional() @IsString() @MaxLength(128) storageTargetId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) storageTargetIds?: string[];
  @IsOptional() @IsIn(['all', 'selected']) databaseScope?: 'all' | 'selected';
  @IsOptional() @IsArray() @IsString({ each: true }) databases?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DatabaseSelectionDto) databaseSelections?: DatabaseSelectionDto[];
  @IsOptional() @IsIn(['single', 'database', 'table']) backupLayout?: 'single' | 'database' | 'table';
  @IsOptional() @ValidateNested() @Type(() => BackupObjectDto) backupObjects?: BackupObjectDto;
  @IsString() @IsNotEmpty() @MaxLength(128) cronExpression!: string;
  @IsOptional() @IsString() @MaxLength(128) timezone?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['none', 'gzip', 'zip']) compression?: 'none' | 'gzip' | 'zip';
  @IsOptional() @IsIn(['none', 'aes-256-gcm']) backupEncryption?: 'none' | 'aes-256-gcm';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) retentionCount?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) retryCount?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(30) @Max(86400) retryDelaySeconds?: number;
  @IsOptional() @IsIn(['skip', 'queue']) overlapPolicy?: 'skip' | 'queue';
  @IsOptional() @IsString() @MaxLength(128) filenamePrefix?: string;
  @IsOptional() @IsString() @MaxLength(64) lastRunAt?: string;
}

export class RestoreDto {
  @IsString() @IsNotEmpty() @MaxLength(128) connectionId!: string;
  @IsIn(['overwrite', 'new']) mode!: string;
  @IsOptional() @IsString() @MaxLength(64) databaseName?: string;
  @IsBoolean() overwriteConfirmed!: boolean;
  @IsOptional() @IsBoolean() verifyAfterRestore?: boolean;
}

export class EnvironmentDto {
  @IsIn(['development', 'production']) environment!: string;
  @IsOptional() @IsBoolean() restart?: boolean;
}

export class NotificationEventsDto {
  @IsOptional() @IsBoolean() backup_success?: boolean;
  @IsOptional() @IsBoolean() backup_failed?: boolean;
  @IsOptional() @IsBoolean() backup_retry?: boolean;
  @IsOptional() @IsBoolean() backup_stale?: boolean;
  @IsOptional() @IsBoolean() storage_failed?: boolean;
  @IsOptional() @IsBoolean() capacity_warning?: boolean;
}

export class NotificationDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['discord', 'telegram', 'generic']) provider?: string;
  @IsOptional() @IsString() @MaxLength(2000) webhookUrl?: string;
  @IsOptional() @IsString() @MaxLength(512) webhookToken?: string;
  @IsOptional() @IsString() @MaxLength(512) botToken?: string;
  @IsOptional() @IsString() @MaxLength(128) chatId?: string;
  @IsOptional() @ValidateNested() @Type(() => NotificationEventsDto) events?: NotificationEventsDto;
}

export class FullExportDto {
  @IsString() @MinLength(1) @MaxLength(512) password!: string;
}

export class FullImportDto {
  @IsObject() package!: Record<string, unknown>;
  @IsString() @MinLength(1) @MaxLength(512) password!: string;
}
