/**
 * Tenant-scoped database query context
 */
export interface TenantContext {
  organizationId: string;
  userId?: string;
}

/**
 * Validates that an operation possesses a valid organizationId context
 */
export function assertTenantContext(context: unknown): asserts context is TenantContext {
  if (
    !context ||
    typeof context !== 'object' ||
    !('organizationId' in context) ||
    typeof (context as { organizationId: unknown }).organizationId !== 'string' ||
    !(context as { organizationId: string }).organizationId.trim()
  ) {
    throw new Error('TenantContext violation: organizationId is required for this operation.');
  }
}

