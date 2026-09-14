import { MigrationError } from './migration-errors.mjs';
import { hasNoTxnFlag, parseMigrationFile, validateId } from './migrate-core.mjs';

// Deliberately a small SQL subset, not a PostgreSQL parser or a safety proof for
// arbitrary reviewed SQL. Unsupported syntax requires the standalone override.
// Only new tables and ordinary non-unique indexes; column/view changes must be
// reviewed together in standalone mode. Every admitted file stays transactional.
// Quoted identifiers/literals never become keywords. Reject dollar quotes and
// backslash escapes rather than guessing at bodies or session string settings.
function tokenize(sql) {
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    const whitespace = /^[ \t\r\n\f\v]+/.exec(rest);
    if (whitespace) { i += whitespace[0].length; continue; }
    if (rest.startsWith('--')) {
      i += /^[^\r\n]*/.exec(rest)[0].length;
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return null;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\0' || sql[i] === '\\') return null;
        if (sql[i++] !== quote) continue;
        if (sql[i] === quote) { i++; continue; }
        closed = true;
        break;
      }
      if (!closed) return null;
      tokens.push(quote === '"' ? '#identifier' : '#literal');
      continue;
    }
    const word = /^[a-z_][a-z0-9_$]*/i.exec(rest);
    if (word) { tokens.push(word[0].toUpperCase()); i += word[0].length; continue; }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    if (number) { tokens.push('#number'); i += number[0].length; continue; }
    if (rest.startsWith('::')) { tokens.push('::'); i += 2; continue; }
    if ('(),.;[]+-'.includes(sql[i])) { tokens.push(sql[i++]); continue; }
    return null;
  }
  return tokens;
}

const TYPES = new Set(('BIGINT INT8 SMALLINT INT2 INTEGER INT INT4 TEXT BOOLEAN BOOL BYTEA '
  + 'UUID JSON JSONB DATE REAL FLOAT4 FLOAT8 NUMERIC DECIMAL VARCHAR CHAR CHARACTER '
  + 'TIMESTAMP TIMESTAMPTZ TIME TIMETZ INTERVAL DOUBLE').split(' '));
const SERIAL_TYPES = new Set(['SERIAL', 'SMALLSERIAL', 'BIGSERIAL']);

class AdditiveStatement {
  constructor(tokens) { this.tokens = tokens; this.position = 0; }
  take(value) {
    if (this.tokens[this.position] !== value) return false;
    this.position++;
    return true;
  }
  identifier() {
    const token = this.tokens[this.position];
    if (token !== '#identifier' && !/^[A-Z_][A-Z0-9_$]*$/.test(token ?? '')) return false;
    this.position++;
    return true;
  }
  name() { return this.identifier() && (!this.take('.') || this.identifier()); }
  list(item) {
    if (!this.take('(') || !item()) return false;
    while (this.take(',')) if (!item()) return false;
    return this.take(')');
  }
  type(newTable = false) {
    const type = this.tokens[this.position++];
    // Domains can carry constraints, including implicit NOT NULL.
    if (!TYPES.has(type) && !(newTable && SERIAL_TYPES.has(type))) return false;
    if (type === 'DOUBLE' && !this.take('PRECISION')) return false;
    if (type === 'CHAR' || type === 'CHARACTER') this.take('VARYING');
    if (this.take('(')) {
      if (!this.take('#number')) return false;
      if (this.take(',') && !this.take('#number')) return false;
      if (!this.take(')')) return false;
    }
    if (['TIMESTAMP', 'TIME'].includes(type) && (this.take('WITH') || this.take('WITHOUT'))) {
      if (!this.take('TIME') || !this.take('ZONE')) return false;
    }
    while (this.take('[')) if (!this.take(']')) return false;
    return true;
  }
  constant() {
    if (this.take('+') || this.take('-')) {
      if (!this.take('#number')) return false;
    } else if (!['#number', '#literal', 'TRUE', 'FALSE', 'NULL'].some(value => this.take(value))) {
      return false;
    }
    return !this.take('::') || this.type();
  }
  column() {
    if (!this.identifier() || !this.type(true)) return false;
    for (;;) {
      if (this.take('NULL')) continue;
      if (this.take('DEFAULT')) { if (!this.constant()) return false; continue; }
      if (this.take('NOT')) { if (!this.take('NULL')) return false; continue; }
      if (this.take('PRIMARY')) { if (!this.take('KEY')) return false; continue; }
      if (this.take('UNIQUE')) continue;
      return true;
    }
  }
  tableElement() {
    this.take('CONSTRAINT') && this.identifier();
    if (this.take('PRIMARY')) return this.take('KEY') && this.list(() => this.identifier());
    if (this.take('UNIQUE')) return this.list(() => this.identifier());
    return this.column();
  }
  createTable() {
    if (this.take('IF') && !(this.take('NOT') && this.take('EXISTS'))) return false;
    return this.name() && this.list(() => this.tableElement());
  }
  createIndex() {
    if (this.take('IF') && !(this.take('NOT') && this.take('EXISTS'))) return false;
    if (!this.identifier() || !this.take('ON')) return false;
    this.take('ONLY');
    if (!this.name() || (this.take('USING') && !this.take('BTREE'))) return false;
    if (!this.list(() => {
      if (!this.identifier()) return false;
      this.take('ASC') || this.take('DESC');
      return !this.take('NULLS') || this.take('FIRST') || this.take('LAST');
    })) return false;
    return !this.take('INCLUDE') || this.list(() => this.identifier());
  }
  allowed() {
    let allowed = false;
    if (this.take('CREATE')) {
      if (this.take('TABLE')) allowed = this.createTable();
      else if (this.take('INDEX')) allowed = this.createIndex();
    }
    return allowed && this.position === this.tokens.length;
  }
}

/** null = supported additive SQL; otherwise a closed, SQL-free reason code. */
export function automaticMigrationReason(sql) {
  if (typeof sql !== 'string') return 'unsupported-syntax';
  // Use the runner's exact flag recognizer, including otherwise harmless files.
  if (hasNoTxnFlag(sql)) return 'non-transactional-file';
  const tokens = tokenize(sql);
  if (!tokens) return 'unsupported-syntax';
  if (tokens.includes('CONCURRENTLY')) return 'concurrent-index';
  if (tokens.some(token => ['DROP', 'TRUNCATE'].includes(token))) return 'destructive-sql';
  if (tokens.some(token => ['DO', 'CALL', 'EXECUTE', 'PREPARE', 'FUNCTION', 'PROCEDURE'].includes(token))) {
    return 'procedural-or-dynamic-sql';
  }
  let statement = [];
  for (const token of [...tokens, ';']) {
    if (token !== ';') { statement.push(token); continue; }
    if (statement[0] === 'ALTER') return 'table-alteration';
    if (statement.length && !new AdditiveStatement(statement).allowed()) return 'outside-additive-subset';
    statement = [];
  }
  return null;
}

function filenameLabel(file) {
  // Match the actual filename parser, but never render a supplied path.
  if (typeof file !== 'string' || /[\\/]/.test(file) || !parseMigrationFile(file)) {
    return '"[invalid filename]"';
  }
  const text = file.length > 256 ? `${file.slice(0, 256)}…[truncated]` : file;
  return JSON.stringify(text).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Call only with the entire ledger-derived pending set, while holding the lock. */
export function assertAutomaticMigrations(pendingMigrations) {
  for (const migration of pendingMigrations) {
    const reason = automaticMigrationReason(migration.sql);
    if (!reason) continue;
    const id = validateId(migration.id) ? migration.id : '[invalid id]';
    const file = filenameLabel(migration.file);
    throw new MigrationError(`Automatic migration blocked: file=${file}, id=${id}, reason=${reason}; `
      + 'run a reviewed standalone migration with AUTOMATIC_MIGRATION unset');
  }
}
