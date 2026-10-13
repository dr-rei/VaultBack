import { BadRequestException } from '@nestjs/common';
import {
  findBinlogSequenceGaps,
  makeScratchDatabaseNames,
  parseDumpBinlogCoordinates,
  parseUtcTargetTime,
  pitrBinlogReplayOptions,
  pitrBinlogTransportOptions,
  pitrDumpCoordinateOption,
  rewritePitrSqlDatabases,
  validatePitrSql
} from '../src/backup/pitr.utils';

describe('PITR helpers', () => {
  it('parses MySQL and MariaDB dump coordinates and chooses engine-specific options', () => {
    expect(parseDumpBinlogCoordinates("-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='mysql-bin.000042', SOURCE_LOG_POS=151;"))
      .toEqual({ file: 'mysql-bin.000042', position: 151 });
    expect(parseDumpBinlogCoordinates("-- CHANGE MASTER TO MASTER_LOG_FILE='mariadb-bin.000007', MASTER_LOG_POS=456;"))
      .toEqual({ file: 'mariadb-bin.000007', position: 456 });
    expect(pitrDumpCoordinateOption('mysql')).toBe('--source-data=2');
    expect(pitrDumpCoordinateOption('mariadb')).toBe('--master-data=2');
    expect(() => pitrDumpCoordinateOption('postgres')).toThrow(BadRequestException);
  });

  it('builds checksum-verified MySQL and MariaDB replay arguments with bounded range and database mapping', () => {
    const mapping = { app: 'vaultback_test_app' };
    for (const engine of ['mysql', 'mariadb']) {
      expect(pitrBinlogReplayOptions(engine, 154, '2026-10-13T04:30:00.000Z', mapping, -420)).toEqual([
        '--verify-binlog-checksum', '--start-position=154', '--stop-datetime=2026-10-13 11:30:00', '--rewrite-db=app->vaultback_test_app'
      ]);
    }
    expect(pitrBinlogTransportOptions('mysql', true, false)).toEqual(['--ssl-mode=DISABLED']);
    expect(pitrBinlogTransportOptions('mysql', true, true)).toEqual(['--ssl-mode=REQUIRED']);
    expect(pitrBinlogTransportOptions('mysql', false, false)).toEqual(['--skip-ssl']);
    expect(pitrBinlogTransportOptions('mariadb', false, true)).toEqual(['--ssl']);
    expect(() => pitrBinlogReplayOptions('postgres', 154, '2026-10-13T04:30:00.000Z', mapping, 0)).toThrow(BadRequestException);
    expect(() => pitrBinlogReplayOptions('mysql', 1, '2026-10-13T04:30:00.000Z', mapping, 0)).toThrow(/start position/);
  });

  it('requires a valid explicit UTC target time', () => {
    expect(parseUtcTargetTime('2026-10-13T04:30:00.000Z').iso).toBe('2026-10-13T04:30:00.000Z');
    for (const value of ['2026-10-13T04:30:00+07:00', '2026-02-30T04:30:00Z', '2026-10-13 04:30:00']) {
      expect(() => parseUtcTargetTime(value)).toThrow(BadRequestException);
    }
  });

  it('detects missing, reordered, unparseable, and changed-prefix logs', () => {
    expect(findBinlogSequenceGaps(['mysql-bin.000001', 'mysql-bin.000003'])).toEqual(['mysql-bin.000002']);
    expect(findBinlogSequenceGaps(['mysql-bin.000002', 'mysql-bin.000001'])).toEqual(['binary log order changed']);
    expect(findBinlogSequenceGaps(['binlog-current'])).toEqual(['unverifiable:binlog-current']);
    expect(findBinlogSequenceGaps(['mysql-bin.000001', 'mariadb-bin.000002'])).toEqual(['binary log prefix changed']);
    expect(findBinlogSequenceGaps(['mysql-bin.000001', 'mysql-bin.000002'])).toEqual([]);
  });

  it('generates unpredictable unique scratch names and rewrites database context only', () => {
    const mapping = makeScratchDatabaseNames(['app', 'reports'], 'vb_pitr_test', '0123456789abcdef0123456789abcdef');
    expect(mapping.app).not.toBe(mapping.reports);
    expect(mapping.app).toMatch(/^vb_pitr_test_0123456789abcdef0123_0$/);
    const prototypeName = makeScratchDatabaseNames(['__proto__'], 'vb_pitr_test', '1123456789abcdef0123456789abcdef');
    expect(Object.hasOwn(prototypeName, '__proto__')).toBe(true);
    const source = "USE `app`; UPDATE `app`.`orders` SET note='`app`.orders is a literal'; /*!40101 USE `reports` */;";
    const rewritten = rewritePitrSqlDatabases(source, mapping);
    expect(rewritten).toContain(`USE \`${mapping.app}\``);
    expect(rewritten).toContain(`\`${mapping.app}\`.\`orders\``);
    expect(rewritten).toContain("note='`app`.orders is a literal'");
    expect(rewritten).toContain(`USE \`${mapping.reports}\``);
  });

  it('rewrites database directives across executable comments and rejects dynamic replay SQL', () => {
    const mapping = { source_db: 'vaultback_scratch' };
    const dump = 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `source_db`;\nUSE `source_db`;';
    const rewritten = rewritePitrSqlDatabases(dump, mapping);
    expect(rewritten).toContain('CREATE DATABASE /*!32312 IF NOT EXISTS*/ `vaultback_scratch`;');
    expect(rewritten).toContain('USE `vaultback_scratch`;');
    expect(() => validatePitrSql("SET @q='DROP TABLE `other_db`.`marker`'; PREPARE s FROM @q; EXECUTE s;", ['source_db']))
      .toThrow(/dynamic SQL/);
    expect(() => validatePitrSql('CALL `source_db`.`maintenance`();', ['source_db']))
      .toThrow(/dynamic SQL/);
    expect(() => validatePitrSql("CREATE FUNCTION sys_eval RETURNS STRING SONAME 'libudf.so';", ['source_db']))
      .toThrow(/server-level/);
    expect(() => validatePitrSql('RESET MASTER;', ['source_db']))
      .toThrow(/server-level/);
  });

  it('rejects cross-database references and server-level statements, including executable comments', () => {
    expect(() => validatePitrSql('USE `outside`; INSERT INTO `outside`.`t` VALUES (1);', ['app']))
      .toThrow(/outside the recorded source set/);
    expect(() => validatePitrSql('/*!50003 CREATE USER `rogue`@`%` */', ['app']))
      .toThrow(/server-level/);
    expect(() => validatePitrSql('GRANT SELECT ON app.* TO user;', ['app']))
      .toThrow(/server-level/);
    expect(() => validatePitrSql('USE `app`; INSERT INTO `app`.`t` VALUES (1);', ['app']))
      .not.toThrow();
  });

  it('allows mysqlbinlog session-variable statements but still rejects unknown databases', () => {
    expect(() => validatePitrSql('SET @@SESSION.PSEUDO_SLAVE_MODE=1; SET @@session.GTID_NEXT=\'ANONYMOUS\';', ['app']))
      .not.toThrow();
    expect(() => validatePitrSql('UPDATE `outside`.`items` SET id=1;', ['app']))
      .toThrow(/outside the recorded source set/);
  });
});
