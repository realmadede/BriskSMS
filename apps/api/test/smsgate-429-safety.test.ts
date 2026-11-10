import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dbStore } from '../src/core/store.js';
import { sql } from '@brisksms/db';
import { MessagingService } from '../src/modules/messaging/messaging.service.js';
import { SmsGateProvider } from '../src/modules/messaging/providers/smsgate.provider.js';
import { GatewayMode, SmsStatus, FeatureKey } from '@brisksms/shared';
import { BriskWorkerRuntime } from '@brisksms/worker';

describe('SMSGate HTTP 429 Safety & Outcome Classification Suite', () => {
  const provider = new SmsGateProvider();
  let orgId: string;
  let messagingService: MessagingService;

  beforeEach(async () => {
    await dbStore.reset();
    orgId = randomUUID();

    // Create test organization
    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'SMSGate 429 Test Org',
      slug: `smsgate-429-${orgId.slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'BUSINESS',
      isActive: true,
    });

    await dbStore.setFeatureDefinitionDefaultValue(FeatureKey.BULK_MESSAGING_ENABLED, 'true');

    messagingService = new MessagingService(provider);
    await messagingService.updateGatewayConfig(orgId, {
      gatewayMode: GatewayMode.MANAGED_GATEWAY,
      apiToken: 'enc_smsgate_token_live_123',
    });

    // Seed initial balance of 100 credits
    await messagingService.purchaseCredits(orgId, 100, 'INITIAL_SEED');
  });

  const creds = {
    mode: GatewayMode.EXTERNAL_RELAY,
    baseUrl: 'https://api.sms-gate.app/3rdparty/v1',
    apiToken: 'test_token',
  };

  const payload = {
    organizationId: '',
    to: '+255754000111',
    content: 'Test message for 429 rate limit classification',
    idempotencyKey: 'idemp_key_429',
  };

  it('1. HTTP 429 produces UNCERTAIN: provider classifies 429 as ambiguous rate-limiting', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Too many requests, slow down' }), {
        status: 429,
        headers: { 'Retry-After': '30' },
      })) as any;

    try {
      const result = await provider.sendMessage(creds, { ...payload, organizationId: orgId });
      assert.equal(result.status, 'UNCERTAIN', 'HTTP 429 must be classified strictly as UNCERTAIN');
      assert.equal(result.rawResponse?.statusCode, 429);
      assert.equal(result.rawResponse?.uncertain, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('2. No automatic credit refund occurs on 429: credits remain reserved and not restored', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('Rate limit exceeded', { status: 429 })) as any;

    try {
      const initialAccount = await messagingService.getOrCreateAccount(orgId);
      assert.equal(initialAccount.creditBalance, 100);

      const msg = await messagingService.sendSingleMessage(orgId, {
        to: '+255754000111',
        content: 'Testing 429 credit holding',
        idempotencyKey: 'idemp_429_credit_check',
      });

      // Message status must be QUEUED (with error message), not FAILED
      assert.equal(msg.status, SmsStatus.QUEUED);
      assert.ok(msg.lastError?.includes('GATEWAY_UNCERTAIN'));

      // Credit balance must remain 99 (1 deducted on reservation, NOT refunded)
      const afterAccount = await messagingService.getOrCreateAccount(orgId);
      assert.equal(afterAccount.creditBalance, 99, 'Credit must NOT be refunded on HTTP 429');

      // Idempotency record must be in UNCERTAIN state
      const idempRecord = await messagingService.getIdempotencyRecord(orgId, 'idemp_429_credit_check');
      assert.equal(idempRecord?.status, 'UNCERTAIN');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('3. No blind redispatch occurs: service records UNCERTAIN without initiating immediate re-attempt', async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response('Rate limit reached', { status: 429 });
    }) as any;

    try {
      await messagingService.sendSingleMessage(orgId, {
        to: '+255754000222',
        content: 'No blind redispatch test',
        idempotencyKey: 'idemp_no_redispatch',
      });

      // Gateway must have been contacted exactly once
      assert.equal(fetchCalls, 1, '429 must not trigger blind in-line retries');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('4. Idempotent replay returns the existing uncertain result without re-contacting gateway', async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response('Rate limited', { status: 429 });
    }) as any;

    try {
      const key = 'idemp_replay_429';

      // First attempt: hits 429 and records UNCERTAIN
      const msg1 = await messagingService.sendSingleMessage(orgId, {
        to: '+255754000333',
        content: 'Idempotent replay test',
        idempotencyKey: key,
      });
      assert.equal(fetchCalls, 1);
      assert.equal(msg1.status, SmsStatus.QUEUED);

      // Replay attempt with same idempotency key
      const msg2 = await messagingService.sendSingleMessage(orgId, {
        to: '+255754000333',
        content: 'Idempotent replay test',
        idempotencyKey: key,
      });

      // Second attempt must return the original message without contacting gateway again
      assert.equal(fetchCalls, 1, 'Replay must return cached UNCERTAIN outcome without hitting gateway');
      assert.equal(msg1.id, msg2.id);

      // Balance remains 99 (no duplicate deduction)
      const account = await messagingService.getOrCreateAccount(orgId);
      assert.equal(account.creditBalance, 99);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('5. Recovery does not dispatch an uncertain message again: background runner leaves UNCERTAIN alone', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('Rate limited', { status: 429 })) as any;

    let recoveryFetchCalls = 0;
    try {
      await messagingService.sendSingleMessage(orgId, {
        to: '+255754000444',
        content: 'Recovery sweep isolation test',
        idempotencyKey: 'idemp_recovery_429',
      });

      // Simulate passage of time on the idempotency record
      await sql`
        UPDATE message_idempotency_records
        SET created_at = NOW() - INTERVAL '120 seconds', updated_at = NOW() - INTERVAL '120 seconds'
        WHERE organization_id = ${orgId} AND idempotency_key = 'idemp_recovery_429'
      `;

      // Set up worker runtime that would record calls if dispatch occurred
      const runtime = new BriskWorkerRuntime(
        async () => {
          recoveryFetchCalls++;
          return { status: 200, ok: true };
        },
        { intervalMs: 50, pendingGraceSeconds: 5 },
      );

      const cycle = await runtime.dispatchRecoveryRunner.runOnce();

      // UNCERTAIN record must NOT be resumed by recovery runner
      assert.equal(cycle.resumed, 0, 'Recovery runner must ignore UNCERTAIN records');
      assert.equal(recoveryFetchCalls, 0, 'No gateway dispatch should be initiated by recovery');

      // Record remains UNCERTAIN
      const idemp = await messagingService.getIdempotencyRecord(orgId, 'idemp_recovery_429');
      assert.equal(idemp?.status, 'UNCERTAIN');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('6. Existing definitive rejection behavior remains correct: 400, 401, 403, 404, 413, 422 return FAILED and refund credits', async () => {
    const definitiveStatuses = [400, 401, 403, 404, 413, 422];

    for (const status of definitiveStatuses) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(`Error ${status}`, { status })) as any;

      try {
        const key = `def_reject_${status}`;
        const initialAccount = await messagingService.getOrCreateAccount(orgId);
        const startingBalance = initialAccount.creditBalance;

        const msg = await messagingService.sendSingleMessage(orgId, {
          to: '+255754000555',
          content: `Test definitive ${status}`,
          idempotencyKey: key,
        });

        // Must be FAILED
        assert.equal(msg.status, SmsStatus.FAILED, `Status ${status} must result in FAILED`);

        // Credit must be refunded back to starting balance
        const afterAccount = await messagingService.getOrCreateAccount(orgId);
        assert.equal(afterAccount.creditBalance, startingBalance, `Credit must be refunded on ${status}`);

        // Idempotency status must be FAILED
        const idemp = await messagingService.getIdempotencyRecord(orgId, key);
        assert.equal(idemp?.status, 'FAILED');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it('7. Network timeout and 5xx behavior remains unchanged: 408, 409, 500, 502, 503, 504 return UNCERTAIN without refund', async () => {
    const ambiguousStatuses = [408, 409, 500, 502, 503, 504];

    for (const status of ambiguousStatuses) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(`Error ${status}`, { status })) as any;

      try {
        const key = `ambig_${status}`;
        const initialAccount = await messagingService.getOrCreateAccount(orgId);
        const startingBalance = initialAccount.creditBalance;

        const msg = await messagingService.sendSingleMessage(orgId, {
          to: '+255754000666',
          content: `Test ambiguous ${status}`,
          idempotencyKey: key,
        });

        assert.equal(msg.status, SmsStatus.QUEUED, `Status ${status} must leave message QUEUED`);
        assert.ok(msg.lastError?.includes('GATEWAY_UNCERTAIN'));

        // Credit must remain reserved (deducted by 1, NOT refunded)
        const afterAccount = await messagingService.getOrCreateAccount(orgId);
        assert.equal(afterAccount.creditBalance, startingBalance - 1, `Credit must NOT be refunded on ${status}`);

        // Idempotency status must be UNCERTAIN
        const idemp = await messagingService.getIdempotencyRecord(orgId, key);
        assert.equal(idemp?.status, 'UNCERTAIN');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // Network timeout / ECONNRESET check
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new Error('Connection reset by peer');
      (err as any).code = 'ECONNRESET';
      throw err;
    }) as any;

    try {
      const key = 'net_err_reset';
      const initialAccount = await messagingService.getOrCreateAccount(orgId);
      const startingBalance = initialAccount.creditBalance;

      const msg = await messagingService.sendSingleMessage(orgId, {
        to: '+255754000777',
        content: 'Test socket reset',
        idempotencyKey: key,
      });

      assert.equal(msg.status, SmsStatus.QUEUED);
      assert.ok(msg.lastError?.includes('GATEWAY_UNCERTAIN'));

      const afterAccount = await messagingService.getOrCreateAccount(orgId);
      assert.equal(afterAccount.creditBalance, startingBalance - 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
