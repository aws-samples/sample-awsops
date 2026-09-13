// Only errors constructed here (or with fixed local context) may reach CLI logs.
// Never copy remote message/name, response bodies, SQL literals, or CLI stderr.
export class MigrationError extends Error {}

const recognizedCodes = new Set([
  'AccessDeniedException', 'DecryptionFailure', 'EncryptionFailure',
  'InternalServiceError', 'InternalServiceErrorException', 'InvalidParameterException',
  'InvalidRequestException', 'ResourceNotFoundException', 'ThrottlingException',
  'TooManyRequestsException', 'UnrecognizedClientException', 'ExpiredTokenException',
  'InvalidSignatureException', 'CredentialsProviderError', 'TokenProviderError',
  'TimeoutError', 'RequestTimeout', 'AbortError', 'NetworkingError',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function diagnosticCodes(error) {
  const codes = [...new Set([error?.name, error?.code].filter(value => recognizedCodes.has(value)))];
  const status = error?.$metadata?.httpStatusCode;
  if (Number.isInteger(status) && status >= 100 && status <= 599) codes.push(`HTTP=${status}`);
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
    codes.push(`SQLSTATE=${error.code}`);
  }
  return codes.length ? codes.join(', ') : 'unclassified error';
}

export function databaseFailure(purpose, error) {
  return new MigrationError(`${purpose}: ${diagnosticCodes(error)}`);
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
