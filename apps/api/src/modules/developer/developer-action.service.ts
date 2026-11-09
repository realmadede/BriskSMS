import { ApiKeyScope } from '@brisksms/shared';
import { ApiKeyService } from './api-key.service.js';
import { MessagingService } from '../messaging/messaging.service.js';

export interface SendMessageActionDto {
  recipientPhone: string;
  message: string;
  simSlot?: number;
  idempotencyKey?: string;
}

export interface SendMessageActionResult {
  success: boolean;
  messageId: string;
  status: string;
  recipientPhone: string;
  costCredits: number;
}

export class DeveloperActionService {
  constructor(
    private readonly apiKeyService: ApiKeyService = new ApiKeyService(),
    private readonly messagingService: MessagingService = new MessagingService(),
  ) {}

  /**
   * Public / Developer Action: Dispatches an SMS message via cellular gateway
   * Authenticated by scoped API Key (e.g. Zapier action, Google Sheets, cURL)
   */
  public async handleSendMessageAction(
    rawApiKey: string,
    dto: SendMessageActionDto,
  ): Promise<SendMessageActionResult> {
    const keyRecord = await this.apiKeyService.validateApiKey(rawApiKey);
    if (!keyRecord) {
      throw new Error('Unauthorized: Invalid or revoked API key');
    }

    if (!keyRecord.scopes.includes(ApiKeyScope.SMS_SEND)) {
      throw new Error('Forbidden: API key does not have required scope (requires sms:send)');
    }

    if (!dto.recipientPhone || !dto.message) {
      throw new Error('Both recipientPhone and message are required');
    }

    const messageRecord = await this.messagingService.sendSingleMessage(keyRecord.organizationId, {
      to: dto.recipientPhone,
      content: dto.message,
      simSlot: dto.simSlot ?? 1,
      idempotencyKey: dto.idempotencyKey,
    });

    return {
      success: true,
      messageId: messageRecord.id,
      status: messageRecord.status,
      recipientPhone: messageRecord.recipientPhone,
      costCredits: messageRecord.costCredits,
    };
  }
}
