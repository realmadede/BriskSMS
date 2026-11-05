import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { organizationService, CreateOrgDto, InviteMemberDto, UpdateRoleDto } from './organization.service.js';
import { authenticate } from '../../core/guards.js';
import { UserRole } from '@brisksms/shared';

export function registerOrganizationRoutes(router: Router): void {
  // Create organization
  router.post('/v1/organizations', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
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
    authenticate(req);
    const userId = req.context.userId!;
    const orgs = await organizationService.listUserOrganizations(userId);
    return {
      success: true,
      data: orgs,
    };
  });

  // Get specific organization
  router.get('/v1/organizations/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.params.id || '';
    const org = await organizationService.getOrganization(orgId, userId);
    return {
      success: true,
      data: org,
    };
  });

  // Invite member
  router.post('/v1/organizations/:id/invitations', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.params.id || '';
    const dto = req.body as unknown as InviteMemberDto;
    const result = await organizationService.inviteMember(orgId, userId, dto);
    return {
      success: true,
      data: result,
    };
  });

  // List members
  router.get('/v1/organizations/:id/members', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.params.id || '';
    const members = await organizationService.listMembers(orgId, userId);
    return {
      success: true,
      data: members,
    };
  });

  // Update member role
  router.patch('/v1/organizations/:id/members/:userId', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const actorUserId = req.context.userId!;
    const orgId = req.params.id || '';
    const targetUserId = req.params.userId || '';
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
    authenticate(req);
    const actorUserId = req.context.userId!;
    const orgId = req.params.id || '';
    const targetUserId = req.params.userId || '';

    await organizationService.removeMember(orgId, actorUserId, targetUserId);
    return {
      success: true,
      data: { message: 'Member successfully removed from organization' },
    };
  });
}
