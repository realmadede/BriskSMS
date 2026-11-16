import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import App from '../src/index.js';
import { ZapierZ, ZapierBundle } from '../src/authentication.js';
import { SendSmsInput } from '../src/actions/send-sms.action.js';

describe('BriskSMS Zapier Integration (@brisksms/zapier-app)', () => {
  it('exports valid Zapier platform application configuration', () => {
    assert.equal(App.version, '1.0.0');
    assert.equal(App.authentication.type, 'oauth2');
    assert.ok(App.triggers.payment_matched);
    assert.ok(App.triggers.payment_needs_review);
    assert.ok(App.creates.send_sms);
    assert.ok(App.creates.create_invoice);
  });

  it('configures OAuth2 with /v1/oauth routes and PKCE S256', () => {
    const auth = App.authentication.oauth2Config;
    assert.equal(auth.authorizeUrl.url, 'https://api.brisksms.com/v1/oauth/authorize');
    assert.equal(auth.authorizeUrl.params.code_challenge_method, 'S256');
    assert.equal(auth.authorizeUrl.params.response_type, 'code');
    assert.equal(auth.autoRefresh, true);
  });

  it('unwraps /v1/auth/me and /v1/oauth/token envelopes properly', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const mockZ: ZapierZ = {
      async request(options) {
        calls.push({ url: options.url, method: options.method || 'GET', body: options.body });
        if (options.url.endsWith('/v1/auth/me')) {
          return {
            status: 200,
            json: {
              success: true,
              data: {
                user: { id: 'usr_1', fullName: 'Amina Ally', email: 'amina@brisk.tz' },
                organizations: [{ id: 'org_99', name: 'Amina Store' }],
              },
            },
            getHeader: () => null,
          };
        }
        return {
          status: 200,
          json: {
            success: true,
            data: { access_token: 'bsk_at_new', refresh_token: 'bsk_rt_new', token_type: 'Bearer' },
          },
          getHeader: () => null,
        };
      },
    };

    const me = (await App.authentication.test(mockZ, {
      authData: { access_token: 'bsk_at_1' },
      inputData: {},
    })) as Record<string, unknown>;
    assert.equal(me.name, 'Amina Ally');
    assert.equal(me.organization_id, 'org_99');

    const tokens = await App.authentication.oauth2Config.getAccessToken(mockZ, {
      authData: {},
      inputData: { code: 'c1', code_verifier: 'v1', redirect_uri: 'https://zapier.com/cb' },
    });
    assert.equal(calls[1]?.url, 'https://api.brisksms.com/v1/oauth/token');
    assert.equal(tokens.access_token, 'bsk_at_new');
  });

  it('performs send_sms and create_invoice actions against /v1 routes and unwraps data', async () => {
    const captured: Array<{ url: string; method: string; body: unknown }> = [];
    const mockZ: ZapierZ = {
      async request(options) {
        captured.push({ url: options.url, method: options.method || 'GET', body: options.body });
        if (options.url.includes('/v1/messages/send')) {
          return {
            status: 200,
            json: { success: true, data: { success: true, messageId: 'msg_test_123', status: 'QUEUED' } },
            getHeader: () => null,
          };
        }
        return {
          status: 201,
          json: {
            success: true,
            data: { invoice: { id: 'inv_123', referenceNumber: 'INV-2026-001', totalAmountCents: '15000000' } },
          },
          getHeader: () => null,
        };
      },
    };

    const smsResult = await App.creates.send_sms.operation.perform(mockZ, {
      authData: { access_token: 'bsk_at_test_token' },
      inputData: { recipientPhone: '+255754000111', message: 'Hello from Zapier!', simSlot: 1 },
    } as ZapierBundle<SendSmsInput>);

    assert.equal(captured[0]?.url, 'https://api.brisksms.com/v1/messages/send');
    assert.equal((smsResult as { messageId: string }).messageId, 'msg_test_123');

    const invResult = await App.creates.create_invoice.operation.perform(mockZ, {
      authData: { access_token: 'bsk_at_test_token' },
      inputData: { referenceNumber: 'INV-2026-001', totalAmountCents: '15000000' },
    });
    assert.equal(captured[1]?.url, 'https://api.brisksms.com/v1/reconciliation/invoices');
    assert.equal((invResult as { id: string }).id, 'inv_123');
  });

  it('subscribes and lists payment_matched & payment_needs_review triggers via /v1/developer/webhooks and /v1/reconciliation/payments', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const mockZ: ZapierZ = {
      async request(options) {
        calls.push({ url: options.url, method: options.method || 'GET', body: options.body });
        if (options.method === 'POST') {
          return {
            status: 201,
            json: { success: true, data: { endpoint: { id: 'webhook_ep_123', active: true } } },
            getHeader: () => null,
          };
        }
        return {
          status: 200,
          json: { success: true, data: { payments: [{ paymentId: 'pay_1', state: 'MATCHED' }] } },
          getHeader: () => null,
        };
      },
    };

    const matchedSub = await App.triggers.payment_matched.operation.performSubscribe(mockZ, {
      authData: { access_token: 'bsk_at_test_token' },
      inputData: {},
      targetUrl: 'https://hooks.example.com/catch/mock_hook_123',
    });
    assert.equal(calls[0]?.url, 'https://api.brisksms.com/v1/developer/webhooks');
    assert.deepEqual(calls[0]?.body, {
      url: 'https://hooks.example.com/catch/mock_hook_123',
      subscribedEvents: ['payment.matched'],
    });
    assert.equal((matchedSub as { id: string }).id, 'webhook_ep_123');

    const matchedList = await App.triggers.payment_matched.operation.performList(mockZ, {
      authData: { access_token: 'bsk_at_test_token' },
      inputData: {},
    });
    assert.equal(calls[1]?.url, 'https://api.brisksms.com/v1/reconciliation/payments?state=MATCHED&limit=5');
    assert.equal(matchedList[0]?.paymentId, 'pay_1');

    const reviewList = await App.triggers.payment_needs_review.operation.performList(mockZ, {
      authData: { access_token: 'bsk_at_test_token' },
      inputData: {},
    });
    assert.equal(calls[2]?.url, 'https://api.brisksms.com/v1/reconciliation/payments?state=REVIEW_REQUIRED&limit=5');
    assert.equal(reviewList.length, 1);
  });
});

