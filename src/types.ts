export type DatabaseEngine = 'mysql' | 'mariadb';
export type StorageType = 'local' | 'ftp' | 'webdav' | 'google-drive' | 'onedrive';

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
  databaseScope: 'all' | 'selected';
  databases: string[];
  backupLayout: 'single' | 'database' | 'table';
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  compression: 'none' | 'gzip' | 'zip';
  retentionCount: number;
  filenamePrefix: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
}
