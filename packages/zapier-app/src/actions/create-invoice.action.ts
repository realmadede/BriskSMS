import { ZapierZ, ZapierBundle } from '../authentication.js';

export interface CreateInvoiceInput {
  referenceNumber: string;
  totalAmountCents: string;
  currency?: string;
  customerPhone?: string;
  customerName?: string;
}

export const createInvoiceAction = {
  key: 'create_invoice',
  noun: 'Invoice',
  display: {
    label: 'Create Invoice for Reconciliation',
    description: 'Registers a commercial invoice in BriskSMS so incoming mobile money payments can be automatically matched.',
  },
  operation: {
    inputFields: [
      {
        key: 'referenceNumber',
        label: 'Invoice Reference Number',
        type: 'string',
        required: true,
        helpText: 'Unique invoice identifier (e.g. INV-2026-001 or ORDER-8899).',
      },
      {
        key: 'totalAmountCents',
        label: 'Total Amount (in Cents / Minor Units)',
        type: 'string',
        required: true,
        helpText: 'Total invoice amount in minor units (e.g. 15000000 for 150,000 TZS).',
      },
      {
        key: 'currency',
        label: 'Currency',
        type: 'string',
        required: false,
        default: 'TZS',
      },
      {
        key: 'customerPhone',
        label: 'Customer Phone',
        type: 'string',
        required: false,
        helpText: 'Customer phone for Tier 2 fallback matching.',
      },
      {
        key: 'customerName',
        label: 'Customer Name',
        type: 'string',
        required: false,
      },
    ],
    perform: async (z: ZapierZ, bundle: ZapierBundle<CreateInvoiceInput>) => {
      const response = await z.request({
        url: 'https://api.brisksms.com/v1/invoices',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: {
          referenceNumber: bundle.inputData.referenceNumber,
          totalAmountCents: bundle.inputData.totalAmountCents,
          currency: bundle.inputData.currency || 'TZS',
          customerPhone: bundle.inputData.customerPhone,
          customerName: bundle.inputData.customerName,
        },
      });

      return response.json;
    },
    sample: {
      id: 'inv_882910482',
      referenceNumber: 'INV-2026-001',
      totalAmountCents: '15000000',
      paidAmountCents: '0',
      status: 'UNPAID',
      currency: 'TZS',
    },
    outputFields: [
      { key: 'id', label: 'Invoice ID' },
      { key: 'referenceNumber', label: 'Reference Number' },
      { key: 'totalAmountCents', label: 'Total Amount (Cents)' },
      { key: 'status', label: 'Invoice Status' },
    ],
  },
};

