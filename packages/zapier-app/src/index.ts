import { authentication } from './authentication.js';
import { paymentMatchedTrigger } from './triggers/payment-matched.trigger.js';
import { paymentNeedsReviewTrigger } from './triggers/payment-needs-review.trigger.js';
import { sendSmsAction } from './actions/send-sms.action.js';
import { createInvoiceAction } from './actions/create-invoice.action.js';

export const App = {
  version: '1.0.0',
  platformVersion: '15.0.0',
  authentication,
  triggers: {
    [paymentMatchedTrigger.key]: paymentMatchedTrigger,
    [paymentNeedsReviewTrigger.key]: paymentNeedsReviewTrigger,
  },
  creates: {
    [sendSmsAction.key]: sendSmsAction,
    [createInvoiceAction.key]: createInvoiceAction,
  },
};

export default App;
