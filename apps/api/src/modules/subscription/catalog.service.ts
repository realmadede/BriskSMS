import {
  CommercialProductDto,
  PlanPriceDto,
  AdminCreatePlanDto,
  PlanNotFoundError,
  BillingInterval,
} from '@brisksms/shared';
import { dbStore, SubscriptionPlanRecord, PlanVersionRecord } from '../../core/store.js';

export class CatalogService {
  async getPublicCatalog(): Promise<CommercialProductDto[]> {
    const rawCatalog = await dbStore.getPublicCatalog();

    return rawCatalog.map(({ product, plans }) => ({
      id: product.id,
      code: product.code,
      name: product.name,
      description: product.description,
      productType: product.productType,
      isActive: product.isActive,
      createdAt: product.createdAt.toISOString(),
      plans: plans.map(({ plan, currentVersion, prices, entitlements }) => ({
        id: plan.id,
        productId: plan.productId,
        code: plan.code,
        name: plan.name,
        description: plan.description,
        isPublic: plan.isPublic,
        createdAt: plan.createdAt.toISOString(),
        currentVersion: {
          id: currentVersion.id,
          planId: currentVersion.planId,
          versionNumber: currentVersion.versionNumber,
          effectiveFrom: currentVersion.effectiveFrom.toISOString(),
          effectiveTo: currentVersion.effectiveTo ? currentVersion.effectiveTo.toISOString() : null,
          isActive: currentVersion.isActive,
          trialPeriodDays: currentVersion.trialPeriodDays,
          gracePeriodDays: currentVersion.gracePeriodDays,
          prices: prices.map((p) => ({
            id: p.id,
            planVersionId: p.planVersionId,
            currency: p.currency,
            amountCents: p.amountCents.toString(),
            billingInterval: p.billingInterval,
            isActive: p.isActive,
          })),
          entitlements: entitlements.map((e) => ({
            id: e.id,
            planVersionId: e.planVersionId,
            featureKey: e.featureKey,
            value: e.value,
          })),
        },
      })),
    }));
  }

  async getPlanByCode(planCode: string): Promise<{
    plan: SubscriptionPlanRecord;
    currentVersion: PlanVersionRecord;
    prices: PlanPriceDto[];
    entitlements: Record<string, string>;
  }> {
    const plan = await dbStore.getPlanByCode(planCode);
    if (!plan) {
      throw new PlanNotFoundError(planCode);
    }

    const currentVersion = await dbStore.getActivePlanVersion(plan.id);
    if (!currentVersion) {
      throw new PlanNotFoundError(`${planCode} (no active version)`);
    }

    const rawPrices = await dbStore.getPlanPrices(currentVersion.id);
    const prices = rawPrices.map((p) => ({
      id: p.id,
      planVersionId: p.planVersionId,
      currency: p.currency,
      amountCents: p.amountCents.toString(),
      billingInterval: p.billingInterval,
      isActive: p.isActive,
    }));

    const rawEntitlements = await dbStore.getPlanEntitlements(currentVersion.id);
    const entitlements: Record<string, string> = {};
    for (const ent of rawEntitlements) {
      entitlements[ent.featureKey] = ent.value;
    }

    return {
      plan,
      currentVersion,
      prices,
      entitlements,
    };
  }

  async adminCreatePlan(dto: AdminCreatePlanDto): Promise<{
    planId: string;
    planCode: string;
    versionNumber: number;
  }> {
    const created = await dbStore.adminCreatePlan({
      productCode: dto.productCode,
      code: dto.code,
      name: dto.name,
      description: dto.description,
      isPublic: dto.isPublic,
      trialPeriodDays: dto.trialPeriodDays,
      gracePeriodDays: dto.gracePeriodDays,
      prices: dto.prices.map((p) => ({
        currency: p.currency,
        amountCents: BigInt(p.amountCents),
        billingInterval: p.billingInterval,
      })),
      entitlements: dto.entitlements,
    });

    return {
      planId: created.plan.id,
      planCode: created.plan.code,
      versionNumber: created.version.versionNumber,
    };
  }

  async adminCreateNewPlanVersion(
    planCode: string,
    dto: {
      prices: Array<{ currency: string; amountCents: string; billingInterval: BillingInterval }>;
      entitlements: Record<string, string>;
      trialPeriodDays?: number;
      gracePeriodDays?: number;
    },
  ): Promise<{ versionId: string; versionNumber: number }> {
    const newVersion = await dbStore.adminCreateNewPlanVersion({
      planCode,
      prices: dto.prices.map((p) => ({
        currency: p.currency,
        amountCents: BigInt(p.amountCents),
        billingInterval: p.billingInterval,
      })),
      entitlements: dto.entitlements,
      trialPeriodDays: dto.trialPeriodDays,
      gracePeriodDays: dto.gracePeriodDays,
    });

    return {
      versionId: newVersion.id,
      versionNumber: newVersion.versionNumber,
    };
  }
}

export const catalogService = new CatalogService();
