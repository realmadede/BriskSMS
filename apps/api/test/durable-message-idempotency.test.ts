import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  GatewayMode,
  FeatureKey,
  CreditLedgerEntryType,
  SmsStatus,
  NormalizedDeliveryEvent,
  MessageDispatchPayload,
  MessageDispatchResult,
} from '@brisksms/shared';
import { sql, resetTestDatabaseState } from '@brisksms/db';
import { dbStore } from '../src/core/store.js';
import { MessagingService } from '../src/modules/messaging/messaging.service.js';
import { MessagingProvider } from '../src/modules/messaging/interfaces/messaging-provider.interface.js';
import { HttpException } from '../src/core/http.js';

describe('Durable Message Dispatch Idempotency & Gateway Outcome Reconciliation', () => {
  let orgId: string;
  let dispatchCallCount = 0;
  let lastDispatchedPayload: MessageDispatchPayload | null = null;
  let shouldSimulateLostResponse = false;

  const mockGatewayProvider: MessagingProvider = {
    async sendMessage(_creds, payload): Promise<MessageDispatchResult> {
      dispatchCallCount++;
      lastDispatchedPayload = payload;

      if (shouldSimulateLostResponse) {
        throw new Error('Connection reset by peer: Gateway accepted socket but lost HTTP response');
      }

      return {
        providerMessageId: `smsgate_prov_${payload.idempotencyKey}`,
        status: 'DISPATCHED',
        rawResponse: { id: `smsgate_prov_${payload.idempotencyKey}`, queued: true },
      };
    },
    verifyWebhookSignature() {
      return true;
    },
    normalizeWebhookPayload(rawPayload): NormalizedDeliveryEvent {
      return {
        providerMessageId: String(rawPayload.messageId || rawPayload.id),
        eventType: (rawPayload.event as any) || 'DELIVERED',
        carrierTimestamp: new Date(),
        failureReason: rawPayload.reason as string | undefined,
      };
    },
  };

  beforeEach(async () => {
    await resetTestDatabaseState();
    dispatchCallCount = 0;
    lastDispatchedPayload = null;
    shouldSimulateLostResponse = false;
    orgId = randomUUID();

    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Brisk Logistics TZA',
      slug: `brisk-logistics-${orgId.slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'BUSINESS',
      isActive: true,
    });

    await dbStore.setFeatureDefinitionDefaultValue(FeatureKey.BULK_MESSAGING_ENABLED, 'true');

    const svc = new MessagingService(mockGatewayProvider);
    await svc.updateGatewayConfig(orgId, {
      gatewayMode: GatewayMode.MANAGED_GATEWAY,
      apiToken: 'enc_smsgate_token_live_123',
    });
    // Seed initial balance of 50 credits
    await svc.purchaseCredits(orgId, 50, 'INITIAL_SEED');
  });

  // 1. Sequential duplicate requests
  it('1. Sequential duplicate requests return original message without duplicate dispatch or deductions', async () => {
    const service = new MessagingService(mockGatewayProvider);
    const idempotencyKey = `seq_idem_${Date.now()}`;
    const payload = {
      to: '+255754000111',
      content: 'Your verification PIN is 849201.',
      idempotencyKey,
    };

    // First request
    const msg1 = await service.sendSingleMessage(orgId, payload);
    assert.equal(msg1.status, SmsStatus.SUBMITTED);
    assert.ok(msg1.id);

    // Second request with same key and identical parameters
    const msg2 = await service.sendSingleMessage(orgId, payload);
    assert.equal(msg2.id, msg1.id, 'Must return identical messageId');
    assert.equal(msg2.status, SmsStatus.SUBMITTED);

    // Assertions
    assert.equal(dispatchCallCount, 1, 'Gateway provider must be invoked exactly once');
    assert.equal(lastDispatchedPayload?.idempotencyKey, idempotencyKey);

    const [messages, ledgerEntries, idempotencyRows, account] = await Promise.all([
      sql<Record<string, any>>`SELECT * FROM sms_messages WHERE organization_id = ${orgId}`,
      sql<Record<string, any>>`SELECT * FROM messaging_credit_ledger WHERE organization_id = ${orgId}`,
      sql<Record<string, any>>`SELECT * FROM message_idempotency_records WHERE organization_id = ${orgId} AND idempotency_key = ${idempotencyKey}`,
      service.getOrCreateAccount(orgId),
    ]);

    assert.equal(messages.length, 1, 'Must persist exactly 1 sms_messages record');
    const deductions = ledgerEntries.filter((l) => l.entry_type === CreditLedgerEntryType.USAGE_DEDUCTION);
    assert.equal(deductions.length, 1, 'Must record exactly 1 usage deduction');
    assert.equal(account.creditBalance, 49, 'Ending credit balance must be exactly 49');

    assert.equal(idempotencyRows.length, 1, 'Must persist exactly 1 idempotency record');
    assert.equal(idempotencyRows[0]!.status, 'COMPLETED');
    assert.equal(idempotencyRows[0]!.message_id, msg1.id);
  });

  // 2. Same key with changed recipient or content
  it('2. Same key with changed recipient or content rejects with HTTP 409 DUPLICATE_IDEMPOTENCY', async () => {
    const service = new MessagingService(mockGatewayProvider);
    const idempotencyKey = `conflict_idem_${Date.now()}`;

    // Initial request
    await service.sendSingleMessage(orgId, {
      to: '+255754000111',
      content: 'Initial notification content',
      idempotencyKey,
    });

    // Conflicting request with changed recipient
    await assert.rejects(
      () =>
        service.sendSingleMessage(orgId, {
          to: '+255754000999',
          content: 'Initial notification content',
          idempotencyKey,
        }),
      (err: any) => {
        assert.ok(err instanceof HttpException);
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'DUPLICATE_IDEMPOTENCY');
        assert.match(err.message, /different request parameters/);
        return true;
      },
    );

    // Conflicting request with changed content
    await assert.rejects(
      () =>
        service.sendSingleMessage(orgId, {
          to: '+255754000111',
          content: 'Altered and completely different content',
          idempotencyKey,
        }),
      (err: any) => {
        assert.ok(err instanceof HttpException);
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'DUPLICATE_IDEMPOTENCY');
        return true;
      },
    );

    assert.equal(dispatchCallCount, 1, 'Gateway must NOT be invoked on conflicting requests');
    const account = await service.getOrCreateAccount(orgId);
    assert.equal(account.creditBalance, 49, 'No additional credit deduction allowed');
  });

  // 3. Same key used by different organizations
  it('3. Same key used by different organizations isolates operations completely', async () => {
    const service = new MessagingService(mockGatewayProvider);
    const otherOrgId = randomUUID();

    await dbStore.seedOrganizationDirect({
      id: otherOrgId,
      name: 'Serengeti Expeditions',
      slug: `serengeti-${otherOrgId.slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'BUSINESS',
      isActive: true,
    });
    await service.updateGatewayConfig(otherOrgId, {
      gatewayMode: GatewayMode.MANAGED_GATEWAY,
      apiToken: 'enc_smsgate_other_org',
    });
    await service.purchaseCredits(otherOrgId, 30, 'SEED_OTHER');

    const sharedKey = `cross_tenant_key_${Date.now()}`;

    // Org 1 sends with sharedKey
    const msg1 = await service.sendSingleMessage(orgId, {
      to: '+255754000111',
      content: 'Message for Org 1',
      idempotencyKey: sharedKey,
    });

    // Org 2 sends with sharedKey
    const msg2 = await service.sendSingleMessage(otherOrgId, {
      to: '+255754000222',
      content: 'Message for Org 2',
      idempotencyKey: sharedKey,
    });

    assert.notEqual(msg1.id, msg2.id, 'Must produce distinct message records');
    assert.equal(dispatchCallCount, 2, 'Both tenant dispatches must proceed independently');

    const [acc1, acc2, idemRecords] = await Promise.all([
      service.getOrCreateAccount(orgId),
      service.getOrCreateAccount(otherOrgId),
      sql<Record<string, any>>`SELECT * FROM message_idempotency_records WHERE idempotency_key = ${sharedKey}`,
    ]);

    assert.equal(acc1.creditBalance, 49);
    assert.equal(acc2.creditBalance, 29);
    assert.equal(idemRecords.length, 2, 'Must persist 2 distinct idempotency records partitioned by org_id');
  });

  // 4. Concurrent requests sharing one key
  it('4. Concurrent requests sharing one key result in exactly one dispatch and one deduction', async () => {
    const service = new MessagingService(mockGatewayProvider);
    const sharedKey = `concur_key_${Date.now()}`;
    const payload = {
      to: '+255754000111',
      content: 'Concurrent execution test message',
      idempotencyKey: sharedKey,
    };

    // Fire 5 simultaneous requests sharing the identical idempotency key
    const settled = await Promise.allSettled([
      service.sendSingleMessage(orgId, payload),
      service.sendSingleMessage(orgId, payload),
      service.sendSingleMessage(orgId, payload),
      service.sendSingleMessage(orgId, payload),
      service.sendSingleMessage(orgId, payload),
    ]);

    // All successful results must return the exact same messageId
    const fulfilled = settled
      .filter((s): s is PromiseFulfilledResult<any> => s.status === 'fulfilled')
      .map((s) => s.value);

    assert.ok(fulfilled.length >= 1, 'At least one request must succeed');
    const firstId = fulfilled[0].id;
    for (const res of fulfilled) {
      assert.equal(res.id, firstId, 'All successful dispatches must share identical messageId');
    }

    assert.equal(dispatchCallCount, 1, 'External gateway must be called strictly once');

    const [messages, ledgerEntries, account] = await Promise.all([
      sql<Record<string, any>>`SELECT * FROM sms_messages WHERE organization_id = ${orgId}`,
      sql<Record<string, any>>`SELECT * FROM messaging_credit_ledger WHERE organization_id = ${orgId} AND reference_id = ${sharedKey}`,
      service.getOrCreateAccount(orgId),
    ]);

    assert.equal(messages.length, 1, 'Exactly one message row created');
    assert.equal(ledgerEntries.length, 1, 'Exactly one ledger deduction created');
    assert.equal(account.creditBalance, 49, 'Deducted exactly 1 credit');
  });

  // 5. Concurrent requests simulated through independent service instances
  it('5. Concurrent requests across independent service instances are coordinated via PostgreSQL', async () => {
    // Two completely independent service instances simulating separate Node.js API processes
    const serviceInstanceA = new MessagingService(mockGatewayProvider);
    const serviceInstanceB = new MessagingService(mockGatewayProvider);

    const sharedKey = `multi_instance_key_${Date.now()}`;
    const payload = {
      to: '+255754000111',
      content: 'Multi-instance process concurrency message',
      idempotencyKey: sharedKey,
    };

    // Fire requests concurrently across instance A and instance B
    const results = await Promise.allSettled([
      serviceInstanceA.sendSingleMessage(orgId, payload),
      serviceInstanceB.sendSingleMessage(orgId, payload),
    ]);

    const successes = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);

    assert.ok(successes.length >= 1, 'At least one instance must fulfill');
    if (successes.length === 2) {
      assert.equal(successes[0].id, successes[1].id, 'Both instances must resolve to identical messageId');
    }

    assert.equal(dispatchCallCount, 1, 'Gateway dispatch must occur strictly once');

    const [messages, deductions, account] = await Promise.all([
      sql<Record<string, any>>`SELECT * FROM sms_messages WHERE organization_id = ${orgId}`,
      sql<Record<string, any>>`SELECT * FROM messaging_credit_ledger WHERE organization_id = ${orgId} AND reference_id = ${sharedKey}`,
      serviceInstanceA.getOrCreateAccount(orgId),
    ]);

    assert.equal(messages.length, 1, 'Database must enforce exactly 1 message record');
    assert.equal(deductions.length, 1, 'Database must enforce exactly 1 ledger deduction');
    assert.equal(account.creditBalance, 49);
  });

  // 6. API restart followed by a retry
  it('6. API restart followed by a retry reads durable state from PostgreSQL without re-dispatching', async () => {
    const serviceBeforeCrash = new MessagingService(mockGatewayProvider);
    const idempotencyKey = `restart_test_${Date.now()}`;
    const payload = {
      to: '+255754000111',
      content: 'Pre-restart message dispatch',
      idempotencyKey,
    };

    const initialMsg = await serviceBeforeCrash.sendSingleMessage(orgId, payload);
    assert.equal(dispatchCallCount, 1);

    // Simulate API process crash & cold restart:
    // Create completely fresh provider and service instance with zero in-memory state
    let restartGatewayCallCount = 0;
    const postRestartProvider: MessagingProvider = {
      ...mockGatewayProvider,
      async sendMessage() {
        restartGatewayCallCount++;
        return { providerMessageId: 'unexpected', status: 'DISPATCHED', rawResponse: {} };
      },
    };
    const serviceAfterRestart = new MessagingService(postRestartProvider);

    // Retry request with same idempotency key
    const retriedMsg = await serviceAfterRestart.sendSingleMessage(orgId, payload);

    assert.equal(retriedMsg.id, initialMsg.id, 'Must return the original message from PostgreSQL');
    assert.equal(restartGatewayCallCount, 0, 'Must NOT invoke gateway after process restart');

    const account = await serviceAfterRestart.getOrCreateAccount(orgId);
    assert.equal(account.creditBalance, 49, 'Balance remains exactly 49');
  });

  // 7. Failure before gateway dispatch
  it('7. Failure before gateway dispatch rolls back atomically and permits clean retry after top-up', async () => {
    const service = new MessagingService(mockGatewayProvider);

    // Drain all credits to 0 to simulate pre-dispatch failure
    await sql`UPDATE messaging_accounts SET credit_balance = 0 WHERE organization_id = ${orgId}`;

    const idempotencyKey = `pre_dispatch_fail_${Date.now()}`;
    const payload = {
      to: '+255754000111',
      content: 'Pre-dispatch insufficient credit message',
      idempotencyKey,
    };

    // Attempt send with 0 credits -> Must throw InsufficientCreditsError
    await assert.rejects(
      () => service.sendSingleMessage(orgId, payload),
      /Insufficient.*credits/i,
    );

    assert.equal(dispatchCallCount, 0, 'Gateway must NOT be invoked when credits are insufficient');

    // Verify database: no corrupted message or idempotency record should remain
    const [messages, idemRows] = await Promise.all([
      sql<Record<string, any>>`SELECT * FROM sms_messages WHERE organization_id = ${orgId}`,
      sql<Record<string, any>>`SELECT * FROM message_idempotency_records WHERE organization_id = ${orgId} AND idempotency_key = ${idempotencyKey}`,
    ]);
    assert.equal(messages.length, 0);
    assert.equal(idemRows.length, 0, 'Idempotency record rolled back with transaction');

    // Operator tops up credits
    await service.purchaseCredits(orgId, 10, 'TOP_UP_RECOVERY');

    // Retry with identical idempotency key -> Must succeed cleanly
    const msg = await service.sendSingleMessage(orgId, payload);
    assert.equal(msg.status, SmsStatus.SUBMITTED);
    assert.equal(dispatchCallCount, 1);

    const account = await service.getOrCreateAccount(orgId);
    assert.equal(account.creditBalance, 9, 'Deducted 1 credit from topped-up balance');
  });

  // 8. Gateway acceptance followed by a simulated lost response
  it('8. Gateway acceptance followed by lost response records UNCERTAIN status without premature refund', async () => {
    const service = new MessagingService(mockGatewayProvider);
    shouldSimulateLostResponse = true;

    const idempotencyKey = `lost_response_key_${Date.now()}`;
    const msg = await service.sendSingleMessage(orgId, {
      to: '+255754000111',
      content: 'Message with simulated lost gateway response',
      idempotencyKey,
    });

    assert.equal(dispatchCallCount, 1);
    assert.equal(msg.status, SmsStatus.SUBMITTED);
    assert.match(String(msg.lastError), /uncertain/i);

    const [account, idemRows, refunds] = await Promise.all([
      service.getOrCreateAccount(orgId),
      service.getIdempotencyRecord(orgId, idempotencyKey),
      sql<Record<string, any>>`SELECT * FROM messaging_credit_ledger WHERE organization_id = ${orgId} AND entry_type = ${CreditLedgerEntryType.REFUND}`,
    ]);

    // Financial Invariant: NEVER issue a premature refund when gateway outcome is uncertain
    assert.equal(account.creditBalance, 49, 'Credits must remain deducted while outcome is uncertain');
    assert.equal(refunds.length, 0, 'No refunds permitted while outcome is uncertain');
    assert.equal(idemRows?.status, 'UNCERTAIN', 'Idempotency record must be marked UNCERTAIN');
  });

  // 9. Retry while the original operation has an uncertain outcome
  it('9. Retry while original operation has UNCERTAIN outcome prevents duplicate gateway dispatch', async () => {
    const service = new MessagingService(mockGatewayProvider);
    shouldSimulateLostResponse = true;

    const idempotencyKey = `uncertain_retry_key_${Date.now()}`;
    const payload = {
      to: '+255754000111',
      content: 'Uncertain dispatch followed by retry',
      idempotencyKey,
    };

    const firstResult = await service.sendSingleMessage(orgId, payload);
    assert.equal(dispatchCallCount, 1);

    // Turn off error simulation to demonstrate that the retry STILL does not re-dispatch
    shouldSimulateLostResponse = false;

    // Client retries with the same idempotency key
    const retryResult = await service.sendSingleMessage(orgId, payload);

    assert.equal(retryResult.id, firstResult.id, 'Must return the original message');
    assert.equal(dispatchCallCount, 1, 'Gateway dispatch must NOT be repeated for uncertain operation');

    const [messages, account] = await Promise.all([
      sql<Record<string, any>>`SELECT * FROM sms_messages WHERE organization_id = ${orgId}`,
      service.getOrCreateAccount(orgId),
    ]);

    assert.equal(messages.length, 1, 'Only 1 message persisted in database');
    assert.equal(account.creditBalance, 49, 'Credits deducted only once');
  });

  // 10. Duplicate terminal failure notifications and duplicate refunds
  it('10. Duplicate terminal failure notifications refund credit exactly once', async () => {
    const service = new MessagingService(mockGatewayProvider);
    const idempotencyKey = `terminal_failure_key_${Date.now()}`;

    const msg = await service.sendSingleMessage(orgId, {
      to: '+255754000111',
      content: 'Message doomed to fail at telco tower',
      idempotencyKey,
    });
    assert.equal(msg.status, SmsStatus.SUBMITTED);

    let account = await service.getOrCreateAccount(orgId);
    assert.equal(account.creditBalance, 49, 'Deducted 1 credit upon initial submission');

    const providerMsgId = msg.providerMessageId!;

    // 1. First webhook arrives reporting terminal failure: sms:failed
    const handled1 = await service.handleDeliveryEvent({
      providerMessageId: providerMsgId,
      eventType: 'FAILED',
      carrierTimestamp: new Date(),
      failureReason: 'Subscriber absent or unreachable',
    });

    assert.notEqual(handled1, null);
    assert.equal(handled1?.status, SmsStatus.FAILED);

    account = await service.getOrCreateAccount(orgId);
    assert.equal(account.creditBalance, 50, 'Credit refunded upon confirmed failure');

    // 2. Duplicate retry of the same terminal failure webhook (network retry / webhook re-delivery)
    const handled2 = await service.handleDeliveryEvent({
      providerMessageId: providerMsgId,
      eventType: 'FAILED',
      carrierTimestamp: new Date(),
      failureReason: 'Subscriber absent or unreachable',
    });

    assert.notEqual(handled2, null);
    assert.equal(handled2?.status, SmsStatus.FAILED);

    account = await service.getOrCreateAccount(orgId);
    assert.equal(account.creditBalance, 50, 'Credit balance must NOT increase again on duplicate webhook');

    const [refundLedgerEntries, idemRecord] = await Promise.all([
      sql<Record<string, any>>`
        SELECT * FROM messaging_credit_ledger
        WHERE organization_id = ${orgId} AND entry_type = ${CreditLedgerEntryType.REFUND}
      `,
      service.getIdempotencyRecord(orgId, idempotencyKey),
    ]);

    assert.equal(refundLedgerEntries.length, 1, 'Ledger must contain strictly 1 refund entry');
    assert.equal(idemRecord?.status, 'FAILED', 'Idempotency record updated to FAILED');
  });
});
