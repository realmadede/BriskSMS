import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureDisabledError, FeatureKey, ApiKeyScope } from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { entitlementService } from '../src/modules/subscription/entitlement.service.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { catalogService } from '../src/modules/subscription/catalog.service.js';
import { grantDeveloperPlan } from './helpers/developer-plan.js';

describe('Plan entitlements are enforced, not just displayed', () => {
  const apiKeyService = new ApiKeyService();
  let orgId: string;

  beforeEach(async () => {
    await dbStore.reset();
    const reg = await authService.register({
      email: 'plans@brisksms.app',
      password: 'Password123!',
      fullName: 'Plan Owner',
      organizationName: 'Plan Test Org',
    });
    orgId = reg.organizationId!;
  });

  it('refuses API, webhook and OAuth features for a workspace whose plan does not include them', async () => {
    await assert.rejects(entitlementService.assertFeatureEnabled(orgId, FeatureKey.API_ACCESS), FeatureDisabledError);
    await assert.rejects(entitlementService.assertFeatureEnabled(orgId, FeatureKey.WEBHOOK_ACCESS), FeatureDisabledError);
    await assert.rejects(
      entitlementService.assertAnyFeatureEnabled(orgId, [FeatureKey.ZAPIER_INTEGRATION, FeatureKey.API_ACCESS]),
      FeatureDisabledError,
    );
  });

  it('allows them once the plan includes them', async () => {
    await grantDeveloperPlan(orgId);
    await entitlementService.assertFeatureEnabled(orgId, FeatureKey.API_ACCESS);
    await entitlementService.assertFeatureEnabled(orgId, FeatureKey.WEBHOOK_ACCESS);
    await entitlementService.assertAnyFeatureEnabled(orgId, [FeatureKey.ZAPIER_INTEGRATION]);
  });

  it('lets a Zapier-only plan use OAuth without API access', async () => {
    await dbStore.setFeatureDefinitionDefaultValue(FeatureKey.ZAPIER_INTEGRATION, 'true');
    try {
      await entitlementService.assertAnyFeatureEnabled(orgId, [FeatureKey.ZAPIER_INTEGRATION, FeatureKey.API_ACCESS]);
      await assert.rejects(entitlementService.assertFeatureEnabled(orgId, FeatureKey.API_ACCESS), FeatureDisabledError);
    } finally {
      await dbStore.setFeatureDefinitionDefaultValue(FeatureKey.ZAPIER_INTEGRATION, 'false');
    }
  });

  it('stops an existing API key working when the plan loses API access', async () => {
    await grantDeveloperPlan(orgId);
    const { plainTextSecret } = await apiKeyService.createApiKey(orgId, {
      organizationId: orgId,
      name: 'Zapier key',
      scopes: [ApiKeyScope.SMS_SEND],
    });
    assert.ok(await apiKeyService.validateApiKey(plainTextSecret), 'key works while the plan includes the API');

    await dbStore.reset();
    const reg = await authService.register({
      email: 'plans2@brisksms.app',
      password: 'Password123!',
      fullName: 'Second Owner',
      organizationName: 'No API Org',
    });
    const created = await apiKeyService.createApiKey(reg.organizationId!, {
      organizationId: reg.organizationId!,
      name: 'Key without a plan',
      scopes: [ApiKeyScope.SMS_SEND],
    });
    assert.equal(await apiKeyService.validateApiKey(created.plainTextSecret), null);
  });

  it('lists private plans for the platform admin but not on the public price list', async () => {
    await grantDeveloperPlan(orgId); // creates the private test plan
    const codes = (rows: Awaited<ReturnType<typeof catalogService.getPublicCatalog>>) => rows.flatMap((p) => (p.plans ?? []).map((pl) => pl.code));
    assert.ok(!codes(await catalogService.getPublicCatalog()).includes('PLAN_TEST_DEVELOPER'));
    assert.ok(codes(await catalogService.getPublicCatalog(true)).includes('PLAN_TEST_DEVELOPER'));
  });
});
