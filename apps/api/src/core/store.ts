import { randomUUID } from 'node:crypto';
import { UserRole, DeviceStatus, DeviceIngestionMode } from '@brisksms/shared';
import { assertTenantContext } from '@brisksms/db';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  phoneNumber?: string;
  isEmailVerified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  timezone: string;
  planTier: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserOrganizationRecord {
  id: string;
  organizationId: string;
  userId: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceRecord {
  id: string;
  organizationId: string;
  label: string;
  deviceModel: string;
  manufacturer: string;
  androidVersion: string;
  appVersion: string;
  publicKeyPem: string;
  status: DeviceStatus;
  ingestionMode: DeviceIngestionMode;
  deviceTokenHash: string;
  lastSyncAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceTelemetryRecord {
  id: string;
  deviceId: string;
  batteryPct: number;
  isCharging: boolean;
  networkType: string;
  signalStrengthDbm: number | null;
  pendingOfflineCount: number;
  recordedAt: Date;
}

export interface PairingTokenRecord {
  token: string;
  organizationId: string;
  createdById: string;
  expiresAt: Date;
  usedAt?: Date;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  userId: string;
  jti: string;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface AuditLogRecord {
  id: string;
  organizationId: string;
  actorId: string;
  actorType: 'USER' | 'DEVICE' | 'SYSTEM' | 'API_KEY';
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export class MemoryStore {
  users = new Map<string, UserRecord>();
  usersByEmail = new Map<string, string>(); // email -> userId

  organizations = new Map<string, OrganizationRecord>();
  orgsBySlug = new Map<string, string>(); // slug -> orgId

  memberships = new Map<string, UserOrganizationRecord>(); // id -> record
  userOrgLookup = new Map<string, string>(); // `${orgId}:${userId}` -> membershipId

  devices = new Map<string, DeviceRecord>();
  deviceTokenIndex = new Map<string, string>(); // tokenHash -> deviceId

  telemetry: DeviceTelemetryRecord[] = [];
  pairingTokens = new Map<string, PairingTokenRecord>();
  refreshTokens = new Map<string, RefreshTokenRecord>(); // tokenHash -> record
  auditLogs: AuditLogRecord[] = [];

  // Reset store for testing
  reset(): void {
    this.users.clear();
    this.usersByEmail.clear();
    this.organizations.clear();
    this.orgsBySlug.clear();
    this.memberships.clear();
    this.userOrgLookup.clear();
    this.devices.clear();
    this.deviceTokenIndex.clear();
    this.telemetry = [];
    this.pairingTokens.clear();
    this.refreshTokens.clear();
    this.auditLogs = [];
  }

  // --- Users ---
  createUser(data: { email: string; passwordHash: string; fullName: string; phoneNumber?: string }): UserRecord {
    const emailNorm = data.email.trim().toLowerCase();
    if (this.usersByEmail.has(emailNorm)) {
      throw new Error('User with this email already exists');
    }
    const id = randomUUID();
    const now = new Date();
    const record: UserRecord = {
      id,
      email: emailNorm,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      phoneNumber: data.phoneNumber,
      isEmailVerified: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(id, record);
    this.usersByEmail.set(emailNorm, id);
    return record;
  }

  findUserByEmail(email: string): UserRecord | null {
    const id = this.usersByEmail.get(email.trim().toLowerCase());
    return id ? this.users.get(id) ?? null : null;
  }

  findUserById(id: string): UserRecord | null {
    return this.users.get(id) ?? null;
  }

  // --- Organizations ---
  createOrganization(data: { name: string; slug: string; creatorUserId: string; countryCode?: string }): {
    org: OrganizationRecord;
    membership: UserOrganizationRecord;
  } {
    const slugNorm = data.slug.trim().toLowerCase();
    if (this.orgsBySlug.has(slugNorm)) {
      throw new Error(`Organization slug '${slugNorm}' is already in use`);
    }

    const orgId = randomUUID();
    const now = new Date();
    const org: OrganizationRecord = {
      id: orgId,
      name: data.name,
      slug: slugNorm,
      countryCode: data.countryCode || 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'STARTER',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.set(orgId, org);
    this.orgsBySlug.set(slugNorm, orgId);

    // Add creator as OWNER
    const membershipId = randomUUID();
    const membership: UserOrganizationRecord = {
      id: membershipId,
      organizationId: orgId,
      userId: data.creatorUserId,
      role: UserRole.OWNER,
      createdAt: now,
      updatedAt: now,
    };
    this.memberships.set(membershipId, membership);
    this.userOrgLookup.set(`${orgId}:${data.creatorUserId}`, membershipId);

    this.recordAudit({
      organizationId: orgId,
      actorId: data.creatorUserId,
      actorType: 'USER',
      action: 'ORGANIZATION_CREATED',
      resourceType: 'ORGANIZATION',
      resourceId: orgId,
    });

    return { org, membership };
  }

  findOrgById(orgId: string): OrganizationRecord | null {
    return this.organizations.get(orgId) ?? null;
  }

  getUserOrganizations(userId: string): { org: OrganizationRecord; role: UserRole }[] {
    const results: { org: OrganizationRecord; role: UserRole }[] = [];
    for (const mem of this.memberships.values()) {
      if (mem.userId === userId) {
        const org = this.organizations.get(mem.organizationId);
        if (org && org.isActive) {
          results.push({ org, role: mem.role });
        }
      }
    }
    return results;
  }

  getMembership(organizationId: string, userId: string): UserOrganizationRecord | null {
    const key = `${organizationId}:${userId}`;
    const id = this.userOrgLookup.get(key);
    return id ? this.memberships.get(id) ?? null : null;
  }

  addMember(data: { organizationId: string; userId: string; role: UserRole; actorId: string }): UserOrganizationRecord {
    assertTenantContext({ organizationId: data.organizationId });
    const key = `${data.organizationId}:${data.userId}`;
    if (this.userOrgLookup.has(key)) {
      throw new Error('User is already a member of this organization');
    }

    const id = randomUUID();
    const now = new Date();
    const record: UserOrganizationRecord = {
      id,
      organizationId: data.organizationId,
      userId: data.userId,
      role: data.role,
      createdAt: now,
      updatedAt: now,
    };
    this.memberships.set(id, record);
    this.userOrgLookup.set(key, id);

    this.recordAudit({
      organizationId: data.organizationId,
      actorId: data.actorId,
      actorType: 'USER',
      action: 'MEMBER_INVITED',
      resourceType: 'USER_ORGANIZATION',
      resourceId: id,
      metadata: { userId: data.userId, role: data.role },
    });

    return record;
  }

  updateMemberRole(data: { organizationId: string; userId: string; newRole: UserRole; actorId: string }): UserOrganizationRecord {
    assertTenantContext({ organizationId: data.organizationId });
    const mem = this.getMembership(data.organizationId, data.userId);
    if (!mem) {
      throw new Error('Member not found in organization');
    }

    mem.role = data.newRole;
    mem.updatedAt = new Date();

    this.recordAudit({
      organizationId: data.organizationId,
      actorId: data.actorId,
      actorType: 'USER',
      action: 'MEMBER_ROLE_UPDATED',
      resourceType: 'USER_ORGANIZATION',
      resourceId: mem.id,
      metadata: { userId: data.userId, newRole: data.newRole },
    });

    return mem;
  }

  removeMember(organizationId: string, userId: string, actorId: string): void {
    assertTenantContext({ organizationId });
    const key = `${organizationId}:${userId}`;
    const id = this.userOrgLookup.get(key);
    if (!id) {
      throw new Error('Member not found in organization');
    }
    this.memberships.delete(id);
    this.userOrgLookup.delete(key);

    this.recordAudit({
      organizationId,
      actorId,
      actorType: 'USER',
      action: 'MEMBER_REMOVED',
      resourceType: 'USER_ORGANIZATION',
      resourceId: id,
      metadata: { userId },
    });
  }

  getOrgMembers(organizationId: string): { user: UserRecord; role: UserRole }[] {
    assertTenantContext({ organizationId });
    const members: { user: UserRecord; role: UserRole }[] = [];
    for (const mem of this.memberships.values()) {
      if (mem.organizationId === organizationId) {
        const user = this.users.get(mem.userId);
        if (user) {
          members.push({ user, role: mem.role });
        }
      }
    }
    return members;
  }

  // --- Devices ---
  createPairingToken(data: { organizationId: string; createdById: string; token: string; ttlSeconds?: number }): PairingTokenRecord {
    assertTenantContext({ organizationId: data.organizationId });
    const expiresAt = new Date(Date.now() + (data.ttlSeconds || 300) * 1000);
    const record: PairingTokenRecord = {
      token: data.token,
      organizationId: data.organizationId,
      createdById: data.createdById,
      expiresAt,
    };
    this.pairingTokens.set(data.token, record);
    return record;
  }

  getPairingToken(token: string): PairingTokenRecord | null {
    const record = this.pairingTokens.get(token);
    if (!record) return null;
    if (record.usedAt || record.expiresAt < new Date()) {
      return null; // Expired or used
    }
    return record;
  }

  registerDevice(data: {
    organizationId: string;
    label: string;
    deviceModel: string;
    manufacturer: string;
    androidVersion: string;
    appVersion: string;
    publicKeyPem: string;
    ingestionMode: DeviceIngestionMode;
    tokenHash: string;
  }): DeviceRecord {
    assertTenantContext({ organizationId: data.organizationId });
    const id = randomUUID();
    const now = new Date();
    const device: DeviceRecord = {
      id,
      organizationId: data.organizationId,
      label: data.label,
      deviceModel: data.deviceModel,
      manufacturer: data.manufacturer,
      androidVersion: data.androidVersion,
      appVersion: data.appVersion,
      publicKeyPem: data.publicKeyPem,
      status: DeviceStatus.ACTIVE,
      ingestionMode: data.ingestionMode,
      deviceTokenHash: data.tokenHash,
      lastSyncAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.devices.set(id, device);
    this.deviceTokenIndex.set(data.tokenHash, id);

    this.recordAudit({
      organizationId: data.organizationId,
      actorId: id,
      actorType: 'DEVICE',
      action: 'DEVICE_REGISTERED',
      resourceType: 'DEVICE',
      resourceId: id,
      metadata: { model: data.deviceModel, mode: data.ingestionMode },
    });

    return device;
  }

  getOrgDevices(organizationId: string): DeviceRecord[] {
    assertTenantContext({ organizationId });
    const devices: DeviceRecord[] = [];
    for (const dev of this.devices.values()) {
      if (dev.organizationId === organizationId) {
        devices.push(dev);
      }
    }
    return devices;
  }

  getDeviceById(deviceId: string, organizationId?: string): DeviceRecord | null {
    const dev = this.devices.get(deviceId);
    if (!dev) return null;
    if (organizationId && dev.organizationId !== organizationId) {
      return null; // Multi-tenant isolation enforcement
    }
    return dev;
  }

  getDeviceByTokenHash(tokenHash: string): DeviceRecord | null {
    const id = this.deviceTokenIndex.get(tokenHash);
    return id ? this.devices.get(id) ?? null : null;
  }

  recordTelemetry(data: {
    deviceId: string;
    batteryPct: number;
    isCharging: boolean;
    networkType: string;
    signalStrengthDbm: number | null;
    pendingOfflineCount: number;
  }): DeviceTelemetryRecord {
    const dev = this.devices.get(data.deviceId);
    if (!dev || dev.status === DeviceStatus.REVOKED) {
      throw new Error('Device is not active or has been revoked');
    }

    const id = randomUUID();
    const now = new Date();
    const record: DeviceTelemetryRecord = {
      id,
      deviceId: data.deviceId,
      batteryPct: data.batteryPct,
      isCharging: data.isCharging,
      networkType: data.networkType,
      signalStrengthDbm: data.signalStrengthDbm,
      pendingOfflineCount: data.pendingOfflineCount,
      recordedAt: now,
    };
    this.telemetry.push(record);

    dev.lastSyncAt = now;
    dev.updatedAt = now;

    return record;
  }

  getDeviceTelemetry(deviceId: string, limit: number = 20): DeviceTelemetryRecord[] {
    return this.telemetry
      .filter((t) => t.deviceId === deviceId)
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .slice(0, limit);
  }

  revokeDevice(deviceId: string, organizationId: string, actorId: string): DeviceRecord {
    assertTenantContext({ organizationId });
    const dev = this.getDeviceById(deviceId, organizationId);
    if (!dev) {
      throw new Error('Device not found in organization');
    }

    dev.status = DeviceStatus.REVOKED;
    dev.revokedAt = new Date();
    dev.updatedAt = new Date();

    // Invalidate token
    this.deviceTokenIndex.delete(dev.deviceTokenHash);

    this.recordAudit({
      organizationId,
      actorId,
      actorType: 'USER',
      action: 'DEVICE_REVOKED',
      resourceType: 'DEVICE',
      resourceId: deviceId,
    });

    return dev;
  }

  // --- Audit Logs (Immutable) ---
  recordAudit(data: {
    organizationId: string;
    actorId: string;
    actorType: 'USER' | 'DEVICE' | 'SYSTEM' | 'API_KEY';
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): AuditLogRecord {
    const id = randomUUID();
    const record: AuditLogRecord = {
      id,
      organizationId: data.organizationId,
      actorId: data.actorId,
      actorType: data.actorType,
      action: data.action,
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      metadata: data.metadata,
      createdAt: new Date(),
    };
    this.auditLogs.push(record);
    return record;
  }
}

export const dbStore = new MemoryStore();
