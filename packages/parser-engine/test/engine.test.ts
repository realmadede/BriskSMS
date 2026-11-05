import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ParserEngine } from '../src/engine.js';
import { PaymentProvider, CurrencyCode, TransactionState } from '@brisksms/shared';

describe('ParserEngine - Tanzanian Mobile Money & Bank Adapters', () => {
  const engine = new ParserEngine();
  const orgId = '018f2d50-1234-7890-b2c3-d4e5f6a7b8c9';
  const testDate = new Date('2026-11-05T14:30:00.000Z');

  it('should parse Vodacom M-Pesa Swahili payment notification', () => {
    const rawSms =
      'QA12BC34DE Imethibitishwa. Umepokea Tsh50,000.00 kutoka kwa JOHN DOE 255754123456 tarehe 05/11/2026 saa 2:30 PM. Salio lako jipya la M-Pesa ni Tsh150,000.00.';

    const result = engine.parseNotification('MPESA', rawSms, orgId, testDate);

    assert.ok(result);
    assert.equal(result.provider, PaymentProvider.MPESA);
    assert.equal(result.reference, 'QA12BC34DE');
    assert.equal(result.amountCents, 5000000n);
    assert.equal(result.currency, CurrencyCode.TZS);
    assert.equal(result.senderPhone, '+255754123456');
    assert.equal(result.senderName, 'JOHN DOE');
    assert.equal(result.state, TransactionState.NORMALIZED);
    assert.equal(typeof result.deduplicationHash, 'string');
    assert.equal(result.deduplicationHash.length, 64);
  });

  it('should parse Vodacom Lipa Kwa M-Pesa Till payment with customer memo', () => {
    const rawSms =
      'QB98XY76LK Imethibitishwa. Umepokea Tsh25,500.00 kutoka kwa 255754987654 - JANE MARY tarehe 05/11/2026 saa 14:10. Akaunti namba: INV-2048. Salio lako jipya ni Tsh300,000.00.';

    const result = engine.parseNotification('M-PESA', rawSms, orgId, testDate);

    assert.ok(result);
    assert.equal(result.provider, PaymentProvider.MPESA);
    assert.equal(result.reference, 'QB98XY76LK');
    assert.equal(result.amountCents, 2550000n);
    assert.equal(result.senderPhone, '+255754987654');
    assert.equal(result.senderName, 'JANE MARY');
    assert.equal(result.customerMemo, 'INV-2048');
  });

  it('should parse Mixx by Yas (Tigo Pesa) payment notification', () => {
    const rawSms =
      'Umepokea Tsh 30,000 kutoka kwa HASSAN ALI (255713456789). Kumbukumbu namba: 98765432101. Tarehe 05/11/2026 15:45. Salio jipya ni Tsh 120,000.';

    const result = engine.parseNotification('MIXX', rawSms, orgId, testDate);

    assert.ok(result);
    assert.equal(result.provider, PaymentProvider.MIXX);
    assert.equal(result.reference, '98765432101');
    assert.equal(result.amountCents, 3000000n);
    assert.equal(result.senderPhone, '+255713456789');
    assert.equal(result.senderName, 'HASSAN ALI');
  });

  it('should parse Airtel Money payment notification', () => {
    const rawSms =
      'Umepokea Tsh 15,000 kutoka kwa BARAKA JUMA (255784998877) tarehe 05/11/2026. Namba ya muamala: AM88990011. Salio jipya ni Tsh 45,000.';

    const result = engine.parseNotification('AIRTELMONEY', rawSms, orgId, testDate);

    assert.ok(result);
    assert.equal(result.provider, PaymentProvider.AIRTEL_MONEY);
    assert.equal(result.reference, 'AM88990011');
    assert.equal(result.amountCents, 1500000n);
    assert.equal(result.senderPhone, '+255784998877');
    assert.equal(result.senderName, 'BARAKA JUMA');
  });

  it('should parse CRDB Bank incoming credit alert', () => {
    const rawSms =
      'CRDB Alert: Credit of TZS 150,000.00 to A/C 01J204839200 from KIBWANA SAIDI Ref: FT2631589402 on 05-Nov-2026. Avail Bal: TZS 1,450,000.00.';

    const result = engine.parseNotification('CRDB', rawSms, orgId, testDate);

    assert.ok(result);
    assert.equal(result.provider, PaymentProvider.CRDB_BANK);
    assert.equal(result.reference, 'FT2631589402');
    assert.equal(result.amountCents, 15000000n);
    assert.equal(result.senderName, 'KIBWANA SAIDI');
    assert.equal(result.recipientAccount, '01J204839200');
  });

  it('should reject personal and non-payment messages safely (return null)', () => {
    const personalSms = 'Habari yako kaka, kesho tutaonana saa ngapi kule ofisini?';
    const result = engine.parseNotification('+255754000111', personalSms, orgId);

    assert.equal(result, null);
  });

  it('should reject empty or malformed strings safely without throwing', () => {
    assert.equal(engine.parseNotification('MPESA', '', orgId), null);
    assert.equal(engine.parseNotification('MPESA', '   ', orgId), null);
    assert.equal(engine.parseNotification('UNKNOWN_SENDER', 'Invalid body text', orgId), null);
  });
});

