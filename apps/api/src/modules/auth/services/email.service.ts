import { EmailProvider, EmailDeliveryResult } from '../providers/email.interface.js';
import { ResendEmailProvider } from '../providers/resend.provider.js';

export class EmailService {
  private provider: EmailProvider;

  constructor(customProvider?: EmailProvider) {
    this.provider = customProvider || new ResendEmailProvider();
  }

  setProvider(provider: EmailProvider): void {
    this.provider = provider;
  }

  getProvider(): EmailProvider {
    return this.provider;
  }

  async sendVerificationEmail(to: string, fullName: string, token: string): Promise<EmailDeliveryResult> {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!to || !emailRegex.test(to.trim())) {
      return { success: false, error: `Invalid recipient email address: '${to}'` };
    }

    const frontendBase = (process.env.FRONTEND_URL || 'https://console.brisksms.com').replace(/\/+$/, '');
    // Use URL fragment (#token=...) to prevent token leakage in HTTP request lines & reverse proxy access logs (RFC 3986)
    const verificationUrl = `${frontendBase}/verify-email#token=${encodeURIComponent(token)}`;
    const expiryHours = parseInt(process.env.EMAIL_VERIFICATION_EXPIRY_HOURS || '24', 10);

    const subject = 'Verify your email address - BriskSMS';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Verify your BriskSMS Account</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F8FAFC; color: #0F172A; margin: 0; padding: 24px; }
    .card { max-width: 540px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; border: 1px solid #E2E8F0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .logo { font-size: 20px; font-weight: 800; color: #D97706; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 700; color: #0F172A; margin-top: 0; }
    p { font-size: 15px; line-height: 1.6; color: #475569; margin: 16px 0; }
    .btn { display: inline-block; background-color: #D97706; color: #FFFFFF !important; font-weight: 600; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 8px; margin: 20px 0; }
    .footer { font-size: 12px; color: #94A3B8; margin-top: 32px; border-top: 1px solid #E2E8F0; padding-top: 16px; }
    .code { font-family: monospace; background: #F1F5F9; padding: 2px 6px; border-radius: 4px; word-break: break-all; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">BriskSMS</div>
    <h1>Verify your email address</h1>
    <p>Hi ${fullName.replace(/</g, '&lt;').replace(/>/g, '&gt;')},</p>
    <p>Thank you for registering with BriskSMS. To complete your account activation and access your merchant workspace, please verify your email address by clicking the button below:</p>
    <p style="text-align: center;">
      <a href="${verificationUrl}" class="btn" target="_blank">Verify Email Address</a>
    </p>
    <p>This verification link will expire in ${expiryHours} hours. If you did not create a BriskSMS account, you can safely ignore this email.</p>
    <p>If the button above does not work, copy and paste this link into your browser:<br>
      <span class="code">${verificationUrl}</span>
    </p>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BriskSMS. All rights reserved.<br>
      Payment Intelligence &amp; Cellular Messaging Platform
    </div>
  </div>
</body>
</html>`;

    const text = `Hi ${fullName},

Thank you for registering with BriskSMS. Please verify your email address by clicking the link below:

${verificationUrl}

This verification link will expire in ${expiryHours} hours. If you did not create a BriskSMS account, you can safely ignore this email.

---
BriskSMS Team`;

    return this.provider.sendEmail({
      to,
      subject,
      html,
      text,
    });
  }

  async sendPasswordResetEmail(to: string, fullName: string, token: string): Promise<EmailDeliveryResult> {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!to || !emailRegex.test(to.trim())) {
      return { success: false, error: `Invalid recipient email address: '${to}'` };
    }

    const frontendBase = (process.env.FRONTEND_URL || 'https://console.brisksms.com').replace(/\/+$/, '');
    const resetUrl = `${frontendBase}/reset-password#token=${encodeURIComponent(token)}`;
    const expiryMinutes = parseInt(process.env.PASSWORD_RESET_EXPIRY_MINUTES || '60', 10);
    const safeName = (fullName || 'Merchant').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const subject = 'Reset your password - BriskSMS';
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Reset your BriskSMS password</title></head>
<body style="font-family: sans-serif; background-color: #F8FAFC; color: #0F172A; padding: 24px;">
  <div style="max-width: 540px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; border: 1px solid #E2E8F0; padding: 32px;">
    <div style="font-size: 20px; font-weight: 800; color: #D97706; margin-bottom: 24px;">BriskSMS</div>
    <h1 style="font-size: 22px; font-weight: 700; margin-top: 0;">Reset your password</h1>
    <p>Hi ${safeName},</p>
    <p>We received a request to reset your BriskSMS password. Click the button below to choose a new password:</p>
    <p style="text-align: center;">
      <a href="${resetUrl}" style="display: inline-block; background-color: #D97706; color: #FFFFFF; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 8px;" target="_blank">Reset Password</a>
    </p>
    <p>This link expires in ${expiryMinutes} minutes. If you did not request a password reset, you can safely ignore this email.</p>
  </div>
</body>
</html>`;

    const text = `Hi ${fullName || 'Merchant'},\n\nReset your BriskSMS password using the link below (expires in ${expiryMinutes} minutes):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.\n\n---\nBriskSMS Team`;

    return this.provider.sendEmail({ to, subject, html, text });
  }

  async sendOrganizationInviteEmail(
    to: string,
    fullName: string,
    organizationName: string,
    role: string,
    token: string,
  ): Promise<EmailDeliveryResult> {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!to || !emailRegex.test(to.trim())) {
      return { success: false, error: `Invalid recipient email address: '${to}'` };
    }

    const frontendBase = (process.env.FRONTEND_URL || 'https://console.brisksms.com').replace(/\/+$/, '');
    const inviteUrl = `${frontendBase}/accept-invite#token=${encodeURIComponent(token)}`;
    const safeName = (fullName || 'Team Member').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeOrg = (organizationName || 'BriskSMS Workspace').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const subject = `You've been invited to join ${organizationName} on BriskSMS`;
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Organization Invitation - BriskSMS</title></head>
<body style="font-family: sans-serif; background-color: #F8FAFC; color: #0F172A; padding: 24px;">
  <div style="max-width: 540px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; border: 1px solid #E2E8F0; padding: 32px;">
    <div style="font-size: 20px; font-weight: 800; color: #D97706; margin-bottom: 24px;">BriskSMS</div>
    <h1 style="font-size: 22px; font-weight: 700; margin-top: 0;">Join ${safeOrg}</h1>
    <p>Hi ${safeName},</p>
    <p>You have been invited to join <strong>${safeOrg}</strong> on BriskSMS with the role <strong>${role}</strong>.</p>
    <p style="text-align: center;">
      <a href="${inviteUrl}" style="display: inline-block; background-color: #D97706; color: #FFFFFF; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 8px;" target="_blank">Accept Invitation</a>
    </p>
    <p>This invitation link expires in 7 days.</p>
  </div>
</body>
</html>`;

    const text = `Hi ${fullName || 'Team Member'},\n\nYou have been invited to join ${organizationName} on BriskSMS (${role}). Accept your invitation and set up your password here:\n\n${inviteUrl}\n\n---\nBriskSMS Team`;

    return this.provider.sendEmail({ to, subject, html, text });
  }
}

export const emailService = new EmailService();
