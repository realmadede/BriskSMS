import { dbStore, OrganizationRecord, UserOrganizationRecord } from '../../core/store.js';
import { UserRole } from '@brisksms/shared';
import { HttpException } from '../../core/http.js';
import { entitlementService } from '../subscription/entitlement.service.js';
import { generateSecureToken, hashToken } from '../../core/crypto.js';
import { withTransaction } from '@brisksms/db';
import { randomUUID } from 'node:crypto';

export interface CreateOrgDto {
  name: string;
  slug?: string;
  countryCode?: string;
}

export interface InviteMemberDto {
  email: string;
  role: UserRole;
  fullName?: string;
}

export interface UpdateRoleDto {
  role: UserRole;
}

export class OrganizationService {
  async createOrganization(userId: string, dto: CreateOrgDto): Promise<{ organization: OrganizationRecord; role: UserRole }> {
    if (!dto.name || !dto.name.trim()) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Organization name is required');
    }

    const rawSlug = dto.slug || dto.name;
    const baseSlug = rawSlug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const uniqueSlug = `${baseSlug}-${randomUUID().slice(0, 6)}`;

    const { org, membership } = await dbStore.createOrganization({
      name: dto.name.trim(),
      slug: uniqueSlug,
      countryCode: dto.countryCode || 'TZA',
      creatorUserId: userId,
    });

    return {
      organization: org,
      role: membership.role,
    };
  }

  async getOrganization(orgId: string, userId: string): Promise<OrganizationRecord> {
    const membership = await dbStore.getMembership(orgId, userId);
    if (!membership) {
      throw new HttpException(403, 'FORBIDDEN', 'You do not have access to this organization');
    }

    const org = await dbStore.findOrgById(orgId);
    if (!org || !org.isActive) {
      throw new HttpException(404, 'ORG_NOT_FOUND', 'Organization not found or inactive');
    }

    return org;
  }

  async listUserOrganizations(userId: string): Promise<{ organization: OrganizationRecord; role: UserRole }[]> {
    const list = await dbStore.getUserOrganizations(userId);
    return list.map((item) => ({
      organization: item.org,
      role: item.role,
    }));
  }

  async inviteMember(
    orgId: string,
    actorUserId: string,
    dto: InviteMemberDto,
  ): Promise<{ membership: UserOrganizationRecord; user: { id: string; email: string; fullName: string } }> {
    if (!dto.email || !dto.role) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Email and role are required');
    }

    if (dto.role === UserRole.OWNER) {
      throw new HttpException(400, 'INVALID_ROLE', 'Cannot invite a member with role OWNER');
    }

    return withTransaction(async (tx) => {
      const actorMem = await dbStore.getMembership(orgId, actorUserId, tx);
      if (!actorMem || ![UserRole.OWNER, UserRole.ADMIN].includes(actorMem.role)) {
        throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can invite team members');
      }

      await entitlementService.enforceMemberQuota(orgId, tx);

      let user = await dbStore.findUserByEmail(dto.email, tx);
      if (!user) {
        user = await dbStore.createUser(
          {
            email: dto.email,
            fullName: dto.fullName || dto.email.split('@')[0] || 'Team Member',
            passwordHash: 'pending_invitation_setup',
          },
          tx,
        );
      }

      const existingMem = await dbStore.getMembership(orgId, user.id, tx);
      if (existingMem) {
        throw new HttpException(409, 'ALREADY_MEMBER', 'This user is already a member of this organization');
      }

      // Record invitation in organization_invitations table
      const inviteTokenHash = hashToken(generateSecureToken('bsk_inv', 24));
      const expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
      await tx`
        INSERT INTO "organization_invitations" (
          "id", "organization_id", "email", "role", "invited_by_id",
          "token_hash", "status", "expires_at", "accepted_at"
        )
        VALUES (
          ${randomUUID()}, ${orgId}, ${user.email}, ${dto.role}::"UserRole", ${actorUserId},
          ${inviteTokenHash}, 'ACCEPTED', ${expiresAt}, NOW()
        )
      `;

      const membership = await dbStore.addMember(
        {
          organizationId: orgId,
          userId: user.id,
          role: dto.role,
          actorId: actorUserId,
        },
        tx,
      );

      return {
        membership,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
        },
      };
    });
  }

  async listMembers(orgId: string, userId: string): Promise<{ id: string; email: string; fullName: string; role: UserRole }[]> {
    const membership = await dbStore.getMembership(orgId, userId);
    if (!membership) {
      throw new HttpException(403, 'FORBIDDEN', 'You do not have access to view members of this organization');
    }

    const members = await dbStore.getOrgMembers(orgId);
    return members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      fullName: m.user.fullName,
      role: m.role,
    }));
  }

  async updateMemberRole(orgId: string, actorUserId: string, targetUserId: string, newRole: UserRole): Promise<UserOrganizationRecord> {
    const actorMem = await dbStore.getMembership(orgId, actorUserId);
    if (!actorMem || ![UserRole.OWNER, UserRole.ADMIN].includes(actorMem.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can modify member roles');
    }

    if (newRole === UserRole.OWNER) {
      throw new HttpException(400, 'INVALID_ROLE', 'Cannot reassign primary OWNER role via update');
    }

    return dbStore.updateMemberRole({
      organizationId: orgId,
      userId: targetUserId,
      newRole,
      actorId: actorUserId,
    });
  }

  async removeMember(orgId: string, actorUserId: string, targetUserId: string): Promise<void> {
    const actorMem = await dbStore.getMembership(orgId, actorUserId);
    if (!actorMem || ![UserRole.OWNER, UserRole.ADMIN].includes(actorMem.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can remove members');
    }

    const targetMem = await dbStore.getMembership(orgId, targetUserId);
    if (targetMem?.role === UserRole.OWNER) {
      throw new HttpException(400, 'CANNOT_REMOVE_OWNER', 'The organization OWNER cannot be removed');
    }

    await dbStore.removeMember(orgId, targetUserId, actorUserId);
  }
}

export const organizationService = new OrganizationService();
