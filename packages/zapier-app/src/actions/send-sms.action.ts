import { ZapierZ, ZapierBundle } from '../authentication.js';

export interface SendSmsInput {
  recipientPhone: string;
  message: string;
  simSlot?: number;
}

export const sendSmsAction = {
  key: 'send_sms',
  noun: 'SMS',
  display: {
    label: 'Send Cellular SMS',
    description: 'Dispatches an SMS message through your connected BriskSMS carrier relay SIM card (e.g. from a Google Sheets row or CRM trigger).',
  },
  operation: {
    inputFields: [
      {
        key: 'recipientPhone',
        label: 'Recipient Phone Number',
        type: 'string',
        required: true,
        helpText: 'Tanzanian phone number in local (0754...) or E.164 (+255754...) format.',
      },
      {
        key: 'message',
        label: 'Message Content',
        type: 'text',
        required: true,
        helpText: 'The text message to dispatch. Can contain spreadsheet row merge variables.',
      },
      {
        key: 'simSlot',
        label: 'SIM Card Slot',
        type: 'integer',
        required: false,
        default: 1,
        choices: [1, 2],
        helpText: 'Select SIM slot 1 or 2 on your dual-SIM cellular relay device.',
      },
    ],
    perform: async (z: ZapierZ, bundle: ZapierBundle<SendSmsInput>) => {
      const response = await z.request({
        url: 'https://api.brisksms.com/v1/messages/send',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bundle.authData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: {
          recipientPhone: bundle.inputData.recipientPhone,
          message: bundle.inputData.message,
          simSlot: bundle.inputData.simSlot || 1,
        },
      });

      return response.json;
    },
    sample: {
      success: true,
      messageId: 'msg_882910482',
      status: 'SENT',
      recipientPhone: '+255754000111',
      costCredits: 1,
    },
    outputFields: [
      { key: 'success', label: 'Success', type: 'boolean' },
      { key: 'messageId', label: 'Message ID' },
      { key: 'status', label: 'Dispatch Status' },
      { key: 'recipientPhone', label: 'Normalized Recipient Phone' },
      { key: 'costCredits', label: 'Credits Deducted' },
    ],
  },
};
