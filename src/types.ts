export type DatabaseEngine = 'mysql' | 'mariadb';
export type StorageType = 'local' | 'ftp' | 'webdav' | 'google-drive' | 'onedrive';

export interface BackupObjectOptions {
  views: boolean;
  routines: boolean;
  triggers: boolean;
  events: boolean;
}

export interface DatabaseConnection {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  databaseScope: 'all' | 'selected';
  databases: string[];
  ssl: boolean;
  createdAt: string;
}

export interface StorageTarget {
  id: string;
  name: string;
  type: StorageType;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface BackupJob {
  id: string;
  name: string;
  databaseConnectionId: string;
  storageTargetId: string;
  databaseConnectionIds?: string[];
  storageTargetIds?: string[];
  databaseSelections?: Array<{ connectionId: string; databases: string[] }>;
  databaseScope: 'all' | 'selected';
  databases: string[];
  backupLayout: 'single' | 'database' | 'table';
  backupObjects: BackupObjectOptions;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  compression: 'none' | 'gzip' | 'zip';
  backupEncryption: 'none' | 'aes-256-gcm';
  retentionCount: number;
  retryCount: number;
  retryDelaySeconds: number;
  overlapPolicy: 'skip' | 'queue';
  filenamePrefix: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
}
