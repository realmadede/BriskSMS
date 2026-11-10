import { EmailProvider, SendEmailOptions, EmailDeliveryResult } from './email.interface.js';

export class ResendEmailProvider implements EmailProvider {
  private readonly defaultFrom: string;
  private readonly apiUrl = 'https://api.resend.com/emails';
  private readonly timeoutMs = 10_000;
  private readonly apiKey?: string;

  constructor(
    apiKey?: string,
    defaultFrom?: string,
  ) {
    this.apiKey = apiKey;
    this.defaultFrom = defaultFrom || process.env.RESEND_FROM_EMAIL || 'BriskSMS <verify@brisksms.com>';
  }

  async sendEmail(options: SendEmailOptions): Promise<EmailDeliveryResult> {
    const key = this.apiKey ?? process.env.RESEND_API_KEY;
    if (!key) {
      return {
        success: false,
        error: 'RESEND_API_KEY is not configured',
      };
    }

    const payload = {
      from: options.from || this.defaultFrom,
      to: [options.to],
      subject: options.subject,
      html: options.html,
      text: options.text,
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key.trim()}`,
          'Content-Type': 'application/json',
          'User-Agent': 'BriskSMS-Auth/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        // Mask any potential sensitive details in error
        const cleanError = errorText.slice(0, 200).replace(/[a-zA-Z0-9_-]{20,}/g, '[REDACTED]');
        return {
          success: false,
          error: `Resend HTTP ${response.status}: ${cleanError}`,
        };
      }

      const data = (await response.json().catch(() => ({}))) as { id?: string };
      return {
        success: true,
        messageId: data.id,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown network failure';
      return {
        success: false,
        error: `Resend network dispatch error: ${msg.replace(/[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')}`,
      };
    }
  }
}

/**
 * Mock Email Provider for tests and offline development
 */
export class MockEmailProvider implements EmailProvider {
  public sentEmails: SendEmailOptions[] = [];
  public failureMode: string | null = null;

  async sendEmail(options: SendEmailOptions): Promise<EmailDeliveryResult> {
    if (this.failureMode) {
      return {
        success: false,
        error: `Mock provider simulated failure: ${this.failureMode}`,
      };
    }
    this.sentEmails.push({ ...options });
    return {
      success: true,
      messageId: `mock_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  clear(): void {
    this.sentEmails = [];
    this.failureMode = null;
  }
}
