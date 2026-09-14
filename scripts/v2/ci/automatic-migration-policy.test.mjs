import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../automatic-migration-policy.mjs';
import { MigrationError } from '../migration-errors.mjs';

const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const migration = sql => ({ id, file: `${id}_example.sql`, sql });
const safe = [
  '',
  '-- DROP TABLE ignored;\r\n/* outer /* TRUNCATE */ comment */ ;',
  'CREATE TABLE public.example (id bigint PRIMARY KEY, label text NOT NULL, enabled boolean DEFAULT false);',
  'CREATE TABLE IF NOT EXISTS example (id bigserial, label text, PRIMARY KEY (id));',
  'CREATE TABLE "DROP" ("TRUNCATE" text, "say""hi" text DEFAULT \'it\'\'s; DROP TABLE t; --\');',
  'CREATE INDEX example_idx ON public.example (id);',
  '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example USING btree (id DESC NULLS LAST) INCLUDE (label);',
  'ALTER TABLE public.example ADD COLUMN label text;',
  'ALTER TABLE IF EXISTS ONLY example ADD label text NULL;',
  'ALTER TABLE example ADD COLUMN IF NOT EXISTS a numeric(12, 2), ADD b varchar(255), ADD c timestamp(6) with time zone;',
  'ALTER TABLE example ADD a text[] DEFAULT \'{}\'::text[], ADD b jsonb DEFAULT \'{"DROP":"literal"}\'::jsonb;',
  'ALTER TABLE example ADD a numeric DEFAULT -1.5, ADD b boolean DEFAULT true;',
  'ALTER/**/TABLE example ADD/* nested /* no */ comment */COLUMN label TEXT;',
  'CREATE TABLE example (id int); ALTER TABLE example ADD label text; CREATE INDEX example_idx ON example (label);',
];
test('automatic policy allows only the supported additive SQL forms', () => {
  for (const sql of safe) {
    assert.equal(policy.automaticMigrationReason(sql), null, sql);
    assert.doesNotThrow(() => policy.assertAutomaticMigrations([migration(sql)]));
  }
});

const unsafe = [
  'DROP TABLE example', 'truncate/**/table example',
  'ALTER TABLE example DROP COLUMN label', 'ALTER TABLE example DROP CONSTRAINT old',
  'ALTER TABLE example RENAME TO other', 'ALTER TABLE example RENAME COLUMN label TO other',
  'ALTER TABLE example ALTER label TYPE int', 'ALTER TABLE example ALTER COLUMN label SET DATA TYPE int',
  'ALTER TABLE example ALTER label SET NOT NULL', 'ALTER TABLE example ALTER label SET DEFAULT 1',
  'ALTER TABLE example ADD label text NOT NULL',
  'ALTER TABLE example ADD label text CONSTRAINT required NOT NULL',
  'ALTER TABLE example ADD CONSTRAINT required CHECK (label IS NOT NULL) NOT VALID',
  'ALTER TABLE example ADD CHECK (label IS NOT NULL)',
  'ALTER TABLE example ADD UNIQUE (label)', 'ALTER TABLE example ADD PRIMARY KEY (label)',
  'ALTER TABLE example ADD FOREIGN KEY (id) REFERENCES other(id)',
  'ALTER TABLE example ADD EXCLUDE USING gist (id WITH =)',
  'ALTER TABLE example ADD label text UNIQUE', 'ALTER TABLE example ADD id int REFERENCES other(id)',
  'ALTER TABLE example ADD id serial', 'ALTER TABLE example ADD id int GENERATED ALWAYS AS IDENTITY',
  'ALTER TABLE example ADD label required_domain', 'ALTER TABLE example ADD label public.text',
  'ALTER TABLE example ADD label "text"',
  'ALTER TABLE example ADD label text, ALTER id TYPE bigint',
  'CREATE UNIQUE INDEX example_idx ON example (label)',
  'CREATE UNIQUE INDEX CONCURRENTLY example_idx ON example (label)',
  'CREATE TABLE example AS SELECT dangerous_function()',
  'CREATE TABLE example (id int) INHERITS (other)',
  'CREATE TABLE example PARTITION OF other DEFAULT',
  'CREATE TABLE example (id int DEFAULT dangerous_function())',
  'ALTER TABLE example ADD label int DEFAULT dangerous_function()',
  'ALTER TABLE example ADD label int DEFAULT 1::dangerous_domain',
  'CREATE INDEX example_idx ON example ((dangerous_function(id)))',
  'CREATE INDEX example_idx ON example (id) WHERE dangerous_function(id)',
  'CREATE INDEX example_idx ON example USING custom_method (id)',
  "DO $$ BEGIN EXECUTE 'DR' || 'OP TABLE example'; END $$",
  "DO $outer$ BEGIN EXECUTE $inner$DROP TABLE example$inner$; END $outer$",
  "DO 'BEGIN EXECUTE ''DROP TABLE example''; END'",
  'CALL change_schema()', "PREPARE q AS SELECT dangerous_function(); EXECUTE q",
  "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS 'DROP TABLE example'",
  "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'DROP TABLE example'; END $$",
  'CREATE FUNCTION f() RETURNS void LANGUAGE SQL BEGIN ATOMIC DELETE FROM example; END',
  "CREATE PROCEDURE p() LANGUAGE sql AS 'TRUNCATE example'",
  'SELECT dangerous_function()', 'WITH gone AS (DELETE FROM example RETURNING *) SELECT * FROM gone',
  'UPDATE example SET label=NULL', 'DELETE FROM example', "COPY example FROM PROGRAM 'command'",
  'SET standard_conforming_strings=off', 'BEGIN; CREATE TABLE example(id int); COMMIT;',
  'CREATE TABLE example(id int); DROP TABLE other;',
  'CREATE TABLE example(id int); /* closed */ TRUNCATE other;',
  'CREATE TABLE example(id int); /* unterminated',
  'CREATE TABLE example (label text DEFAULT \'unterminated);',
  'CREATE TABLE "unterminated (id int);',
  String.raw`CREATE TABLE example (label text DEFAULT 'escape\'); DROP TABLE other; --');`,
  String.raw`CREATE TABLE example (label text DEFAULT E'escape\'); DROP TABLE other; --');`,
  'ALTER TABLE example ADD label text DEFAULT $$DROP TABLE other$$',
  'ALTER TABLE example ADD label text DEFAULT U&\'\\0044ROP\'',
  'CREATE TABLE example(id int)\0; DROP TABLE other;',
];
test('contract changes, executable bodies, ambiguous syntax and unknown forms fail closed', () => {
  for (const sql of unsafe) {
    assert.match(policy.automaticMigrationReason(sql), /^[a-z-]+$/, sql);
    assert.throws(() => policy.assertAutomaticMigrations([migration(sql)]), MigrationError, sql);
  }
});

test('every pending file is checked and diagnostics contain only safe metadata and a fixed reason', () => {
  assert.throws(() => policy.assertAutomaticMigrations([
    migration('CREATE TABLE safe (id int)'),
    { ...migration("DROP TABLE do_not_echo_sql"), id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      file: '01ARZ3NDEKTSV4RRFFQ69G5FAW_unsafe.sql' },
  ]), error => {
    assert.match(error.message, /01ARZ3NDEKTSV4RRFFQ69G5FAW_unsafe.sql/);
    assert.match(error.message, /reason=destructive-sql/);
    assert.match(error.message, /standalone.*AUTOMATIC_MIGRATION/);
    assert.doesNotMatch(error.message, /do_not_echo_sql|DROP TABLE/);
    return true;
  });
  assert.throws(() => policy.assertAutomaticMigrations([{
    id: 'forged\n::warning::', file: 'forged\u2028::warning::', sql: 'DROP TABLE secret',
  }]), error => {
    assert.doesNotMatch(error.message, /forged|warning|secret|[\n\u2028]/);
    return true;
  });
});
