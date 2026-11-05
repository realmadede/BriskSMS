/**
 * Organization Role-Based Access Control (RBAC)
 */
export enum UserRole {
  /** Organization Owner: Full legal and administrative control, billing ownership */
  OWNER = 'OWNER',

  /** Administrator: Device management, integration rules, team invitations */
  ADMIN = 'ADMIN',

  /** Finance Manager / Accountant: Invoice management, reconciliation review, ledger exports */
  FINANCE = 'FINANCE',

  /** Cashier / Support Agent: Read-only payment verification, customer inquiry assistance */
  CASHIER = 'CASHIER',

  /** Developer: API keys, webhook endpoint management, event inspection */
  DEVELOPER = 'DEVELOPER',
}

/**
 * Global system-level role for internal platform administration
 */
export enum PlatformRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  SUPPORT_ENGINEER = 'SUPPORT_ENGINEER',
  USER = 'USER',
}

