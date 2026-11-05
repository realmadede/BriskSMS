import { computeDeduplicationHash, TransactionState } from '@brisksms/shared';
import { IProviderAdapter, ParsedPaymentResult } from './interfaces.js';
import { MpesaAdapter } from './adapters/mpesa.adapter.js';
import { MixxAdapter } from './adapters/mixx.adapter.js';
import { AirtelAdapter } from './adapters/airtel.adapter.js';
import { HalopesaAdapter } from './adapters/halopesa.adapter.js';
import { CrdbAdapter } from './adapters/crdb.adapter.js';

export interface NormalizedPaymentDraft extends ParsedPaymentResult {
  organizationId: string;
  deduplicationHash: string;
  state: TransactionState;
}

export class ParserEngine {
  private readonly adapters: IProviderAdapter[] = [];

  constructor() {
    // Register default Tanzanian provider adapters
    this.registerAdapter(new MpesaAdapter());
    this.registerAdapter(new MixxAdapter());
    this.registerAdapter(new AirtelAdapter());
    this.registerAdapter(new HalopesaAdapter());
    this.registerAdapter(new CrdbAdapter());
  }

  /**
   * Registers a custom or versioned provider adapter
   */
  public registerAdapter(adapter: IProviderAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * Inspects sender and message text, selects the matching provider,
   * parses the content, and computes the deterministic deduplication hash.
   */
  public parseNotification(
    senderAddress: string,
    body: string,
    organizationId: string,
    receivedAt: Date = new Date(),
  ): NormalizedPaymentDraft | null {
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      return null;
    }

    // Find the first adapter capable of parsing this notification
    for (const adapter of this.adapters) {
      if (adapter.canParse(senderAddress, trimmedBody)) {
        const parsed = adapter.parse(trimmedBody, receivedAt);
        if (parsed) {
          const deduplicationHash = computeDeduplicationHash(
            organizationId,
            parsed.provider,
            parsed.reference,
            parsed.amountCents,
            parsed.providerTimestamp,
          );

          return {
            ...parsed,
            organizationId,
            deduplicationHash,
            state: TransactionState.NORMALIZED,
          };
        }
      }
    }

    return null;
  }
}

