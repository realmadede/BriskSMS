/**
 * Base Application and Domain Error for BriskSMS
 */
export class BriskError extends Error {
  public readonly isOperational = true;

  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown when an operation attempts to access or mutate cross-tenant resources
 */
export class TenantMismatchError extends BriskError {
  constructor(message = 'Access denied: Resource does not belong to the authenticated organization.') {
    super('TENANT_MISMATCH', message, 403);
  }
}

/**
 * Thrown when an illegal state transition is attempted on the financial state machine
 */
export class InvalidStateTransitionError extends BriskError {
  constructor(fromState: string, toState: string) {
    super(
      'INVALID_STATE_TRANSITION',
      `Illegal transaction transition from '${fromState}' to '${toState}'.`,
      422,
      { fromState, toState },
    );
  }
}

/**
 * Thrown when a duplicate payment payload hash is submitted
 */
export class DuplicatePaymentError extends BriskError {
  constructor(deduplicationHash: string, reference?: string) {
    super(
      'DUPLICATE_PAYMENT',
      `Duplicate transaction detected. Reference '${reference || deduplicationHash}' has already been processed.`,
      409,
      { deduplicationHash, reference },
    );
  }
}

/**
 * Thrown when a revoked or quarantined Android device attempts authentication
 */
export class DeviceRevokedError extends BriskError {
  constructor(deviceId: string) {
    super(
      'DEVICE_REVOKED',
      `Device '${deviceId}' has been revoked or quarantined. Request rejected.`,
      401,
      { deviceId },
    );
  }
}

/**
 * Thrown when payload cryptographic signature verification fails
 */
export class InvalidSignatureError extends BriskError {
  constructor(message = 'Cryptographic signature verification failed.') {
    super('INVALID_SIGNATURE', message, 401);
  }
}

/**
 * Thrown when an organization attempts bulk SMS dispatch with insufficient prepaid credits
 */
export class InsufficientCreditsError extends BriskError {
  constructor(required: number, available: number) {
    super(
      'INSUFFICIENT_CREDITS',
      `Insufficient messaging credits. Required: ${required}, Available balance: ${available}.`,
      402,
      { required, available },
    );
  }
}

/**
 * Thrown when tenant plan quotas are exceeded
 */
export class QuotaExceededError extends BriskError {
  constructor(resource: string, limit: number) {
    super(
      'QUOTA_EXCEEDED',
      `Organization plan quota exceeded for ${resource}. Maximum allowed: ${limit}.`,
      429,
      { resource, limit },
    );
  }
}
