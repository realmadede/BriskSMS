import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTanzanianPhone,
  isValidTanzanianMobileNumber,
  detectTanzanianCarrier,
  inferCarrierHintFromPrefix,
  TANZANIAN_MOBILE_PREFIXES,
  PaymentProvider,
} from '../src/index.js';

describe('Phone Utilities & Carrier Detection', () => {
  it('normalizes local 10-digit phone number with leading 0', () => {
    assert.equal(normalizeTanzanianPhone('0754123456'), '255754123456');
    assert.equal(normalizeTanzanianPhone('0754123456', true), '+255754123456');
  });

  it('normalizes international formatted numbers with spaces, pluses, dashes', () => {
    assert.equal(normalizeTanzanianPhone('+255 784-999-000'), '255784999000');
    assert.equal(normalizeTanzanianPhone('255-713-000-111'), '255713000111');
    assert.equal(normalizeTanzanianPhone('768123456'), '255768123456');
  });

  it('rejects invalid or foreign numbers', () => {
    assert.throws(() => normalizeTanzanianPhone('0123456789'), /Invalid Tanzanian mobile phone number/);
    assert.throws(() => normalizeTanzanianPhone('+12345678901'), /Invalid Tanzanian mobile phone number/);
    assert.throws(() => normalizeTanzanianPhone(''), /Phone number must be a non-empty string/);
  });

  it('validates Tanzanian mobile numbers accurately', () => {
    assert.equal(isValidTanzanianMobileNumber('0754123456'), true); // Vodacom
    assert.equal(isValidTanzanianMobileNumber('0713000111'), true); // Tigo
    assert.equal(isValidTanzanianMobileNumber('0684123456'), true); // Airtel
    assert.equal(isValidTanzanianMobileNumber('0624123456'), true); // Halopesa
    assert.equal(isValidTanzanianMobileNumber('0732123456'), true); // TTCL
    assert.equal(isValidTanzanianMobileNumber('0799123456'), false); // Unassigned prefix
    assert.equal(isValidTanzanianMobileNumber('not_a_phone'), false);
  });

  it('detects carriers correctly based on prefix', () => {
    // Vodacom M-Pesa
    assert.equal(detectTanzanianCarrier('0742123456'), PaymentProvider.MPESA);
    assert.equal(detectTanzanianCarrier('0754123456'), PaymentProvider.MPESA);
    assert.equal(detectTanzanianCarrier('0768123456'), PaymentProvider.MPESA);

    // Mixx by Yas (Tigo Pesa)
    assert.equal(detectTanzanianCarrier('0713123456'), PaymentProvider.MIXX);
    assert.equal(detectTanzanianCarrier('0655123456'), PaymentProvider.MIXX);
    assert.equal(detectTanzanianCarrier('0672123456'), PaymentProvider.MIXX);

    // Airtel Money
    assert.equal(detectTanzanianCarrier('0784123456'), PaymentProvider.AIRTEL_MONEY);
    assert.equal(detectTanzanianCarrier('0684123456'), PaymentProvider.AIRTEL_MONEY);
    assert.equal(detectTanzanianCarrier('0692123456'), PaymentProvider.AIRTEL_MONEY);

    // Halopesa
    assert.equal(detectTanzanianCarrier('0622123456'), PaymentProvider.HALOPESA);
    assert.equal(detectTanzanianCarrier('0612123456'), PaymentProvider.HALOPESA);

    // TTCL
    assert.equal(detectTanzanianCarrier('0734123456'), PaymentProvider.TTCL_PESA);
  });

  it('exports canonical Tanzanian numbering prefixes and inferCarrierHintFromPrefix including 061/077', () => {
    assert.ok(TANZANIAN_MOBILE_PREFIXES.includes('61'));
    assert.ok(TANZANIAN_MOBILE_PREFIXES.includes('77'));
    assert.equal(inferCarrierHintFromPrefix('0612123456'), PaymentProvider.HALOPESA);
    assert.equal(inferCarrierHintFromPrefix('0773123456'), PaymentProvider.MIXX);
  });
});
