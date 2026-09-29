import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dynamoAccount, migrationExport, sqliteAccount } from '../../scripts/migration/export.js';
import { prepareMigration } from '../../scripts/migration/prepare.js';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const row = {
  id: '1',
  printing_id: 'bolt',
  language: 'en',
  finish: 'nonfoil',
  condition: 'NM',
  quantity: 2,
};
const catalog = [
  { printingId: 'bolt', cardId: 'oracle', language: 'en', finishes: ['nonfoil'], paper: true },
];

describe('restored offline export adapters', () => {
  it('reads a consistent SQLite profile without changing its bytes and preserves receipts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keeper-migration-test-'));
    directories.push(dir);
    const file = path.join(dir, 'synthetic.db'),
      db = new DatabaseSync(file);
    db.exec(`create table inventory(id text,printing_id text,language text,finish text,condition text,quantity integer);
      create table documents(owner text,space text,id text,version integer,value text);
      create table operations(id text,input text);`);
    db.prepare('insert into inventory values(?,?,?,?,?,?)').run(
      row.id,
      row.printing_id,
      row.language,
      row.finish,
      row.condition,
      row.quantity,
    );
    db.prepare('insert into operations values(?,?)').run('receipt', '{"original":"unchanged"}');
    db.close();
    const before = await readFile(file),
      exported = sqliteAccount(file, 'alice', 'cognito-alice');
    expect(await readFile(file)).toEqual(before);
    expect(exported.operations).toEqual([{ id: 'receipt', input: '{"original":"unchanged"}' }]);
    expect(
      prepareMigration(migrationExport('backup', [exported], catalog)).accounts[0]!.copies,
    ).toHaveLength(2);
  });

  it('keeps DynamoDB owners and replay partitions separate', () => {
    const source = dynamoAccount(
      [
        { ...row, PK: 'USER#alice', SK: '1' },
        { ...row, PK: 'USER#bob', SK: '1', quantity: 99 },
        { PK: 'OPERATIONS#alice', SK: 'operation', fingerprint: 'keep' },
        { PK: 'REVIEWBATCH#alice', SK: 'ITEM#item', fingerprint: 'keep-too' },
        {
          PK: 'META#alice#import-receipts',
          SK: 'closed',
          id: 'closed',
          version: 1,
          value: { added_at: 'old-time' },
        },
      ],
      'alice',
      'alice',
    );
    expect(source.inventory).toHaveLength(1);
    expect(source.operations).toHaveLength(2);
    const plan = prepareMigration(migrationExport('snapshot', [source], catalog));
    expect(plan.state).toBe('prepared');
    expect(plan.accounts[0]!.copies).toHaveLength(2);
    expect(plan.archive).toEqual(migrationExport('snapshot', [source], catalog));
  });

  it('rejects duplicate keys, active inventory locks and identity mismatches', () => {
    const item = { ...row, PK: 'USER#alice', SK: '1' };
    expect(() => dynamoAccount([item, item], 'alice', 'alice')).toThrow('Duplicate');
    expect(() =>
      dynamoAccount([{ PK: 'META#alice#locks', SK: 'inventory' }], 'alice', 'alice'),
    ).toThrow('lock');
    expect(() => dynamoAccount([{ ...item, id: 'other' }], 'alice', 'alice')).toThrow('identity');
  });

  it('runs the offline CLI, reports blockers privately and refuses to overwrite an artifact', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keeper-migration-cli-'));
    directories.push(dir);
    const cli = path.join(dir, 'prepare.mjs'),
      input = path.join(dir, 'export.json'),
      output = path.join(dir, 'plan.json');
    await build({
      entryPoints: ['scripts/migration/cli.ts'],
      outfile: cli,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'silent',
    });
    const source = dynamoAccount([{ ...row, PK: 'USER#alice', SK: '1' }], 'alice', 'alice');
    const exported = migrationExport('synthetic', [source], catalog);
    exported.accounts[0]!.documents.push({
      space: 'unknown-private-space',
      id: 'private-reference',
      version: 1,
      value: {},
    });
    await writeFile(input, JSON.stringify(exported));
    const run = () => spawnSync(process.execPath, [cli, input, output], { encoding: 'utf8' });
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('"blockers":1');
    expect(result.stdout + result.stderr).not.toContain('private-reference');
    const original = await readFile(output, 'utf8');
    expect(JSON.parse(original).issues[0].reference).toBe(
      'unknown-private-space/private-reference',
    );
    expect(run().status).toBe(1);
    expect(await readFile(output, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(input, 'utf8'))).toEqual(exported);
  });
});
