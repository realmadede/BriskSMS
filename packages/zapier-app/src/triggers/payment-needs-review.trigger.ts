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
        url: 'https://api.brisksms.com/v1/webhooks/endpoints',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: {
          targetUrl: bundle.targetUrl,
          subscribedEvents: ['payment.needs_review'],
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
