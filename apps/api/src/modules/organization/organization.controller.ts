import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { organizationService, CreateOrgDto, InviteMemberDto, UpdateRoleDto } from './organization.service.js';
import { authenticate, assertHumanSessionAuth } from '../../core/guards.js';
import { UserRole } from '@brisksms/shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidParam(value: string | undefined, paramName: string): string {
  const trimmed = (value || '').trim();
  if (!UUID_REGEX.test(trimmed)) {
    throw new HttpException(400, 'INVALID_UUID', `${paramName} must be a valid UUID`);
  }
  return trimmed;
}

export function registerOrganizationRoutes(router: Router): void {
  // Create organization
  router.post('/v1/organizations', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'organization creation');
    const userId = req.context.userId!;
    const dto = req.body as unknown as CreateOrgDto;
    const result = await organizationService.createOrganization(userId, dto);
    return {
      success: true,
      data: result,
    };
  });

  // List user's organizations
  router.get('/v1/organizations', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'listing user organizations');
    const userId = req.context.userId!;
    const orgs = await organizationService.listUserOrganizations(userId);
    return {
      success: true,
      data: orgs,
    };
  });

  // Get specific organization
  router.get('/v1/organizations/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'reading organization details');
    const userId = req.context.userId!;
    const orgId = assertUuidParam(req.params.id, 'organization id');
    const org = await organizationService.getOrganization(orgId, userId);
    return {
      success: true,
      data: org,
    };
  });

  // Invite member
  router.post('/v1/organizations/:id/invitations', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'inviting organization members');
    const userId = req.context.userId!;
    const orgId = assertUuidParam(req.params.id, 'organization id');
    const dto = req.body as unknown as InviteMemberDto;
    const result = await organizationService.inviteMember(orgId, userId, dto);
    return {
      success: true,
      data: result,
    };
  });

  // List members
  router.get('/v1/organizations/:id/members', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'listing organization members');
    const userId = req.context.userId!;
    const orgId = assertUuidParam(req.params.id, 'organization id');
    const members = await organizationService.listMembers(orgId, userId);
    return {
      success: true,
      data: members,
    };
  });

  // Update member role
  router.patch('/v1/organizations/:id/members/:userId', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'updating member roles');
    const actorUserId = req.context.userId!;
    const orgId = assertUuidParam(req.params.id, 'organization id');
    const targetUserId = assertUuidParam(req.params.userId, 'userId');
    const dto = req.body as unknown as UpdateRoleDto;

    if (!dto.role || !Object.values(UserRole).includes(dto.role)) {
      throw new HttpException(400, 'INVALID_ROLE', 'Valid UserRole is required');
    }

    const updated = await organizationService.updateMemberRole(orgId, actorUserId, targetUserId, dto.role);
    return {
      success: true,
      data: updated,
    };
  });

  // Remove member
  router.delete('/v1/organizations/:id/members/:userId', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'removing organization members');
    const actorUserId = req.context.userId!;
    const orgId = assertUuidParam(req.params.id, 'organization id');
    const targetUserId = assertUuidParam(req.params.userId, 'userId');

    await organizationService.removeMember(orgId, actorUserId, targetUserId);
    return {
      success: true,
      data: { message: 'Member successfully removed from organization' },
    };
  });
}
