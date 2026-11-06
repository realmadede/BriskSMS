import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import App from '../src/index.js';
import { ZapierZ, ZapierBundle } from '../src/authentication.js';

describe('BriskSMS Zapier Integration (@brisksms/zapier-app)', () => {
  it('exports valid Zapier platform application configuration', () => {
    assert.equal(App.version, '1.0.0');
    assert.equal(App.authentication.type, 'oauth2');
    assert.ok(App.triggers.payment_matched);
    assert.ok(App.triggers.payment_needs_review);
    assert.ok(App.creates.send_sms);
    assert.ok(App.creates.create_invoice);
  });

  it('configures OAuth2 with PKCE code_challenge_method S256', () => {
    const auth = App.authentication.oauth2Config;
    assert.equal(auth.authorizeUrl.params.code_challenge_method, 'S256');
    assert.equal(auth.authorizeUrl.params.response_type, 'code');
    assert.equal(auth.autoRefresh, true);
  });

  it('performs send_sms action through z.request', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedBody: unknown = null;

    const mockZ: ZapierZ = {
      async request(options) {
        capturedUrl = options.url;
        capturedMethod = options.method || 'GET';
        capturedBody = options.body;
        return {
          status: 200,
          json: { success: true, messageId: 'msg_test_123', status: 'SENT' },
          getHeader: () => null,
        };
      },
    };

    const mockBundle: ZapierBundle<{ recipientPhone: string; message: string; simSlot: number }> = {
      authData: { access_token: 'bsk_at_test_token' },
      inputData: {
        recipientPhone: '+255754000111',
        message: 'Hello from Google Sheets via Zapier!',
        simSlot: 1,
      },
    };

    const result = await App.creates.send_sms.operation.perform(mockZ, mockBundle);

    assert.equal(capturedUrl, 'https://api.brisksms.com/v1/messages/send');
    assert.equal(capturedMethod, 'POST');
    assert.deepEqual(capturedBody, {
      recipientPhone: '+255754000111',
      message: 'Hello from Google Sheets via Zapier!',
      simSlot: 1,
    });
    assert.equal((result as { success: boolean }).success, true);
  });

  it('subscribes payment_matched trigger hook', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;

    const mockZ: ZapierZ = {
      async request(options) {
        capturedUrl = options.url;
        capturedBody = options.body;
        return {
          status: 201,
          json: { id: 'webhook_ep_123', active: true },
          getHeader: () => null,
        };
      },
    };

    const mockBundle: ZapierBundle = {
      authData: { access_token: 'bsk_at_test_token' },
      inputData: {},
      targetUrl: 'https://hooks.zapier.com/hooks/catch/123/abc/',
    };

    const result = await App.triggers.payment_matched.operation.performSubscribe(mockZ, mockBundle);

    assert.equal(capturedUrl, 'https://api.brisksms.com/v1/webhooks/endpoints');
    assert.deepEqual(capturedBody, {
      targetUrl: 'https://hooks.zapier.com/hooks/catch/123/abc/',
      subscribedEvents: ['payment.matched'],
    });
    assert.equal((result as { id: string }).id, 'webhook_ep_123');
  });
});

