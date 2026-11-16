import { ZapierZ, ZapierBundle } from '../authentication.js';

export const paymentMatchedTrigger = {
  key: 'payment_matched',
  noun: 'Payment Match',
  display: {
    label: 'Payment Matched (Settled)',
    description: 'Triggers instantly when incoming payment evidence is matched to an outstanding invoice.',
  },
  operation: {
    type: 'hook',
    performSubscribe: async (z: ZapierZ, bundle: ZapierBundle) => {
      const response = await z.request({
        url: 'https://api.brisksms.com/v1/developer/webhooks',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: {
          url: bundle.targetUrl,
          subscribedEvents: ['payment.matched'],
        },
      });
      if (response.status >= 400) {
        throw new Error(`Webhook subscribe failed with HTTP status ${response.status}`);
      }
      const raw = response.json as Record<string, unknown>;
      const data = raw?.data as Record<string, unknown> | undefined;
      return (data?.endpoint as Record<string, unknown> | undefined) ?? data ?? raw;
    },
    performUnsubscribe: async (z: ZapierZ, bundle: ZapierBundle<{ id: string }>) => {
      const response = await z.request({
        url: `https://api.brisksms.com/v1/developer/webhooks/${bundle.inputData.id}`,
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
        },
      });
      if (response.status >= 400) {
        throw new Error(`Webhook unsubscribe failed with HTTP status ${response.status}`);
      }
      const raw = response.json as Record<string, unknown>;
      return (raw?.data as Record<string, unknown> | undefined) ?? raw;
    },
    perform: async (_z: ZapierZ, bundle: ZapierBundle<{ data: Record<string, unknown> }>) => {
      return [bundle.inputData.data || bundle.inputData];
    },
    performList: async (z: ZapierZ, bundle: ZapierBundle) => {
      const response = await z.request({
        url: 'https://api.brisksms.com/v1/reconciliation/payments?state=MATCHED&limit=5',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
        },
      });
      if (response.status >= 400) {
        throw new Error(`List matched payments failed with HTTP status ${response.status}`);
      }
      if (Array.isArray(response.json)) {
        return response.json;
      }
      const raw = response.json as Record<string, unknown>;
      const data = raw?.data as Record<string, unknown> | undefined;
      if (Array.isArray(data?.payments)) {
        return data.payments as Array<Record<string, unknown>>;
      }
      return [raw];
    },
    sample: {
      paymentId: 'pay_992018491',
      invoiceId: 'inv_8829104',
      invoiceReference: 'INV-2026-44',
      amountCents: '15000000',
      totalAmountCents: '15000000',
      confidenceTier: 'TIER_1_EXACT_REFERENCE',
      provider: 'MPESA',
      reference: 'QA8921KL90',
      senderPhone: '+255754000111',
      senderName: 'Juma Baraka',
      reconciledAt: '2026-11-06T12:00:00Z',
    },
    outputFields: [
      { key: 'paymentId', label: 'Payment ID' },
      { key: 'invoiceId', label: 'Invoice ID' },
      { key: 'invoiceReference', label: 'Invoice Reference' },
      { key: 'amountCents', label: 'Amount (Minor Cents)' },
      { key: 'provider', label: 'Payment Provider' },
      { key: 'reference', label: 'Provider Reference' },
      { key: 'senderPhone', label: 'Sender Phone' },
      { key: 'senderName', label: 'Sender Name' },
    ],
  },
};

