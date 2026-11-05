import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { organizationService } from '../src/modules/organization/organization.service.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { dbStore } from '../src/core/store.js';
import { UserRole } from '@brisksms/shared';

describe('Phase 1: OrganizationModule & Multi-Tenancy Isolation', () => {
  beforeEach(() => {
    dbStore.reset();
  });

  it('should provision a new organization and assign the creator as OWNER', async () => {
    const userRes = await authService.register({
      email: 'owner@serengeti-safaris.co.tz',
      password: 'OwnerPassword123!',
      fullName: 'Baraka Mushi',
    });

    const orgRes = await organizationService.createOrganization(userRes.user.id, {
      name: 'Serengeti Safari Logistics',
      countryCode: 'TZA',
    });

    assert.ok(orgRes.organization.id);
    assert.equal(orgRes.organization.name, 'Serengeti Safari Logistics');
    assert.equal(orgRes.organization.planTier, 'STARTER');
    assert.equal(orgRes.role, UserRole.OWNER);

    // Verify creator can access their organization
    const fetchedOrg = await organizationService.getOrganization(orgRes.organization.id, userRes.user.id);
    assert.equal(fetchedOrg.id, orgRes.organization.id);
  });

  it('should enforce multi-tenant isolation and forbid unauthorized cross-tenant access', async () => {
    // Tenant A
    const userA = await authService.register({
      email: 'tenant_a@business.co.tz',
      password: 'Password123!',
      fullName: 'User A',
      organizationName: 'Company A',
    });

    // Tenant B
    const userB = await authService.register({
      email: 'tenant_b@business.co.tz',
      password: 'Password123!',
      fullName: 'User B',
      organizationName: 'Company B',
    });

    // User B attempts to access Company A's organization details
    await assert.rejects(
      organizationService.getOrganization(userA.organizationId!, userB.user.id),
      /You do not have access to this organization/,
    );
  });

  it('should allow OWNER and ADMIN to invite members with specific roles and prevent CASHIER from inviting', async () => {
    const ownerRes = await authService.register({
      email: 'founder@isp.co.tz',
      password: 'FounderPassword123!',
      fullName: 'Founder User',
      organizationName: 'Dar Fiber Net',
    });
    const orgId = ownerRes.organizationId!;

    // Owner invites an Accountant as FINANCE
    const inviteRes = await organizationService.inviteMember(orgId, ownerRes.user.id, {
      email: 'accountant@isp.co.tz',
      role: UserRole.FINANCE,
      fullName: 'Jane Accountant',
    });
    assert.equal(inviteRes.membership.role, UserRole.FINANCE);
    assert.equal(inviteRes.user.email, 'accountant@isp.co.tz');

    // Owner invites a Cashier
    const cashierRes = await organizationService.inviteMember(orgId, ownerRes.user.id, {
      email: 'frontdesk@isp.co.tz',
      role: UserRole.CASHIER,
      fullName: 'Cashier Agent',
    });

    // Cashier attempts to invite another member -> must be rejected with 403
    await assert.rejects(
      organizationService.inviteMember(orgId, cashierRes.user.id, {
        email: 'intruder@isp.co.tz',
        role: UserRole.DEVELOPER,
      }),
      /Only Owners and Admins can invite team members/,
    );
  });

  it('should update member role and prevent deleting the organization OWNER', async () => {
    const ownerRes = await authService.register({
      email: 'head@enterprise.co.tz',
      password: 'HeadPassword123!',
      fullName: 'Head of Enterprise',
      organizationName: 'Enterprise Ltd',
    });
    const orgId = ownerRes.organizationId!;

    const memberRes = await organizationService.inviteMember(orgId, ownerRes.user.id, {
      email: 'support@enterprise.co.tz',
      role: UserRole.CASHIER,
    });

    // Promote Cashier to FINANCE
    const updated = await organizationService.updateMemberRole(orgId, ownerRes.user.id, memberRes.user.id, UserRole.FINANCE);
    assert.equal(updated.role, UserRole.FINANCE);

    // Attempting to remove the primary OWNER must be forbidden
    await assert.rejects(
      organizationService.removeMember(orgId, ownerRes.user.id, ownerRes.user.id),
      /The organization OWNER cannot be removed/,
    );
  });
});
