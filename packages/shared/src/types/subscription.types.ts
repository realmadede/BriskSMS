import { ProductType, BillingInterval, SubscriptionStatus, EntitlementType } from '../enums/subscription.enum.js';

export interface CommercialProductDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  productType: ProductType;
  isActive: boolean;
  plans?: SubscriptionPlanDto[];
  createdAt: string;
}

export interface PlanPriceDto {
  id: string;
  planVersionId: string;
  currency: string;
  amountCents: string; // Serialized string representation of BigInt
  billingInterval: BillingInterval;
  isActive: boolean;
}

export interface PlanEntitlementDto {
  id: string;
  planVersionId: string;
  featureKey: string;
  value: string;
}

export interface FeatureDefinitionDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: EntitlementType;
  defaultValue: string;
}

export interface PlanVersionDto {
  id: string;
  planId: string;
  versionNumber: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  trialPeriodDays: number;
  gracePeriodDays: number;
  prices: PlanPriceDto[];
  entitlements: PlanEntitlementDto[];
}

export interface SubscriptionPlanDto {
  id: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  currentVersion?: PlanVersionDto;
  versions?: PlanVersionDto[];
  createdAt: string;
}

export interface OrganizationSubscriptionDto {
  id: string;
  organizationId: string;
  planVersionId: string;
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  currency: string;
  unitPriceCents: string;
  billingInterval: BillingInterval;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  canceledAt: string | null;
  cancelAtPeriodEnd: boolean;
  entitlements: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface EntitlementCheckResult {
  allowed: boolean;
  featureKey: string;
  currentValue: string | number | boolean;
  limit?: number;
  currentUsage?: number;
  remaining?: number;
}

export interface CheckoutSubscriptionDto {
  planCode: string;
  currency: string;
  billingInterval: BillingInterval;
  paymentMethodRef?: string;
}

export interface AdminCreatePlanDto {
  productCode: string;
  code: string;
  name: string;
  description?: string;
  isPublic?: boolean;
  trialPeriodDays?: number;
  gracePeriodDays?: number;
  prices: Array<{
    currency: string;
    amountCents: string;
    billingInterval: BillingInterval;
  }>;
  entitlements: Record<string, string>;
}

export interface AdminSetPriceDto {
  planCode: string;
  currency: string;
  amountCents: string;
  billingInterval: BillingInterval;
}

export interface AdminSetEntitlementDto {
  planCode: string;
  featureKey: string;
  value: string;
}
