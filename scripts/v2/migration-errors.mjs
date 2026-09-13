// Only errors constructed here (or with fixed local context) may reach CLI logs.
// Only reviewed baseline/ULID SQL may supply bounded audit/repair text.
// Secret, connection and reader-sync errors never expose remote free text.
export class MigrationError extends Error {}

// Shared with the CI classifier. Freeze both levels so consumers cannot expand
// the safe logging allowlist or inject labels into public diagnostics.
export const diagnosticCodeGroups = Object.freeze({
  'transport connectivity': Object.freeze([
    'TimeoutError', 'RequestTimeout', 'AbortError', 'NetworkingError',
    'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  ]),
  'transport TLS': Object.freeze([
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ]),
  'AWS access/decryption': Object.freeze([
    'AccessDeniedException', 'DecryptionFailure', 'EncryptionFailure',
    'UnrecognizedClientException', 'ExpiredTokenException', 'InvalidSignatureException',
    'CredentialsProviderError', 'TokenProviderError',
  ]),
  'AWS missing resource': Object.freeze(['ResourceNotFoundException']),
  'AWS throttling': Object.freeze(['ThrottlingException', 'TooManyRequestsException']),
  'AWS service/request': Object.freeze([
    'InternalServiceError', 'InternalServiceErrorException', 'InvalidParameterException', 'InvalidRequestException',
  ]),
  'filesystem': Object.freeze(['ENOENT', 'EACCES', 'EPERM', 'EBUSY']),
});
const recognizedCodes = new Set(Object.values(diagnosticCodeGroups).flat());

export function diagnosticCodes(error) {
  const codes = [...new Set([error?.name, error?.code].filter(value => recognizedCodes.has(value)))];
  const status = error?.$metadata?.httpStatusCode;
  if (Number.isInteger(status) && status >= 100 && status <= 599) codes.push(`HTTP=${status}`);
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
    && !recognizedCodes.has(error.code)) {
    codes.push(`SQLSTATE=${error.code}`);
  }
  return codes.length ? codes.join(', ') : 'unclassified error';
}

// JSON quoting prevents forged log lines; escape terminal controls, Unicode
// separators and bidi controls too. Bound input before encoding (max ~12 KiB).
function auditText(value) {
  if (typeof value !== 'string') return '';
  const text = value.length > 2048 ? `${value.slice(0, 2048)}…[truncated]` : value;
  return JSON.stringify(text).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function migrationFields(error) {
  const fields = [];
  if (['ERROR', 'FATAL', 'PANIC', 'WARNING', 'NOTICE', 'INFO', 'LOG', 'DEBUG'].includes(error?.severity)) {
    fields.push(`severity=${error.severity}`);
  }
  for (const key of ['schema', 'table', 'column', 'constraint']) {
    if (typeof error?.[key] === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(error[key])) {
      fields.push(`${key}=${error[key]}`);
    }
  }
  return fields;
}

export function migrationNotice(message) {
  return `  [db] notice (${[diagnosticCodes(message), ...migrationFields(message)].join(', ')}) message=${auditText(message?.message)}`;
}

export function databaseFailure(purpose, error, { migrationSql = false } = {}) {
  if (error instanceof MigrationError) return new MigrationError(`${purpose}: ${error.message}`);
  const fields = [diagnosticCodes(error)];
  if (migrationSql) {
    fields.push(...migrationFields(error));
    // P0001 is the default for repo-authored RAISE EXCEPTION repair guidance.
    // Never print detail/hint/where/query, or messages for other SQLSTATEs.
    if (error?.code === 'P0001') fields.push(`message=${auditText(error.message)}`);
  }
  return new MigrationError(`${purpose}: ${fields.join(', ')}`);
}

export function secretFailure(purpose, error) {
  return new MigrationError(`${purpose}: Secrets Manager GetSecretValue read failed (${diagnosticCodes(error)})`);
}

export async function readSecretForPurpose(readSecret, arn, purpose) {
  if (typeof readSecret !== 'function') throw new MigrationError(`${purpose}: secret reader is not configured`);
  try { return await readSecret(arn); } catch (error) {
    // readJsonSecret has already scrubbed transport/parser failures.
    if (error instanceof MigrationError) throw new MigrationError(`${purpose}: ${error.message}`);
    throw secretFailure(purpose, error);
  }
}

export function terraformFailure(output, error) {
  // Classify a few actionable CLI failures; never emit any stderr substring.
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const category = ['ENOENT', 'EACCES'].includes(error?.code) ? 'executable-unavailable'
    : /Backend initialization required/i.test(stderr) ? 'backend-initialization'
      : /Output "[^"\r\n]+" not found|No outputs found/i.test(stderr) ? 'missing-output'
        : error?.signal ? 'command-terminated' : 'command-failed';
  const exit = Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255
    ? error.status : 'unavailable';
  return new MigrationError(`Terraform output ${output} unavailable (category=${category}, exit=${exit})`);
}
