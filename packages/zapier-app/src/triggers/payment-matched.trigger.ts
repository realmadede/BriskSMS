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
        url: 'https://api.brisksms.com/v1/webhooks/endpoints',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: {
          targetUrl: bundle.targetUrl,
          subscribedEvents: ['payment.matched'],
        },
      });
      return response.json;
    },
    performUnsubscribe: async (z: ZapierZ, bundle: ZapierBundle<{ id: string }>) => {
      const response = await z.request({
        url: `https://api.brisksms.com/v1/webhooks/endpoints/${bundle.inputData.id}`,
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
        },
      });
      return response.json;
    },
    perform: async (_z: ZapierZ, bundle: ZapierBundle<{ data: Record<string, unknown> }>) => {
      return [bundle.inputData.data || bundle.inputData];
    },
    performList: async (z: ZapierZ, bundle: ZapierBundle) => {
      const response = await z.request({
        url: 'https://api.brisksms.com/v1/payments?state=MATCHED&limit=5',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
        },
      });
      return Array.isArray(response.json) ? response.json : [response.json];
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

