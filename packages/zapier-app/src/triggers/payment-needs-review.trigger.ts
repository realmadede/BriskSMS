import { ZapierZ, ZapierBundle } from '../authentication.js';

export const paymentNeedsReviewTrigger = {
  key: 'payment_needs_review',
  noun: 'Payment Review Alert',
  display: {
    label: 'Payment Needs Review',
    description: 'Triggers when a transaction is ambiguous, overpaid, or requires accountant allocation.',
  },
  operation: {
    type: 'hook',
    performSubscribe: async (z: ZapierZ, bundle: ZapierBundle) => {
      const response = await z.request({
        url: 'https://api.brisksms.app/v1/developer/webhooks',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: {
          url: bundle.targetUrl,
          subscribedEvents: ['payment.needs_review'],
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
        url: `https://api.brisksms.app/v1/developer/webhooks/${bundle.inputData.id}`,
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
        url: 'https://api.brisksms.app/v1/reconciliation/payments?state=REVIEW_REQUIRED&limit=5',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
        },
      });
      if (response.status >= 400) {
        throw new Error(`List review payments failed with HTTP status ${response.status}`);
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
      paymentId: 'pay_993021948',
      reference: 'QA99118822',
      amountCents: '5000000',
      senderPhone: '+255754111222',
      reason: 'Multiple open invoices found for phone number; manual review required',
      candidateInvoiceIds: ['inv_111', 'inv_222'],
    },
    outputFields: [
      { key: 'paymentId', label: 'Payment ID' },
      { key: 'reference', label: 'Reference' },
      { key: 'amountCents', label: 'Amount (Cents)' },
      { key: 'senderPhone', label: 'Sender Phone' },
      { key: 'reason', label: 'Review Reason' },
    ],
  },
};

