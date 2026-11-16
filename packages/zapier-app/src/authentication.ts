export interface ZapierBundle<T = Record<string, unknown>> {
  authData: {
    access_token?: string;
    refresh_token?: string;
    organization_id?: string;
    [key: string]: unknown;
  };
  inputData: T;
  targetUrl?: string;
}

export interface ZapierZ {
  request: (options: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers?: Record<string, string>;
    body?: string | Record<string, unknown>;
  }) => Promise<{
    status: number;
    json: Record<string, unknown> | Array<Record<string, unknown>>;
    getHeader: (header: string) => string | null;
  }>;
}

function unwrapEnvelope(json: unknown): Record<string, unknown> {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
      return obj.data as Record<string, unknown>;
    }
    return obj;
  }
  return {};
}

/**
 * Zapier OAuth 2.0 with PKCE Authentication Configuration
 */
export const authentication = {
  type: 'oauth2',
  test: async (z: ZapierZ, bundle: ZapierBundle) => {
    const response = await z.request({
      url: 'https://api.brisksms.com/v1/auth/me',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bundle.authData.access_token}`,
      },
    });

    if (response.status !== 200) {
      throw new Error(`Authentication test failed with HTTP status ${response.status}`);
    }

    const payload = unwrapEnvelope(response.json);
    const user = (payload.user as Record<string, unknown> | undefined) ?? undefined;
    const organizations = Array.isArray(payload.organizations)
      ? (payload.organizations as Array<Record<string, unknown>>)
      : [];
    return {
      ...payload,
      name: (user?.fullName as string | undefined) || (user?.email as string | undefined) || (payload.name as string | undefined),
      organization_id: (organizations[0]?.id as string | undefined) || (payload.organization_id as string | undefined),
    };
  },
  oauth2Config: {
    authorizeUrl: {
      url: 'https://api.brisksms.com/v1/oauth/authorize',
      params: {
        client_id: '{{process.env.CLIENT_ID}}',
        state: '{{bundle.inputData.state}}',
        redirect_uri: '{{bundle.inputData.redirect_uri}}',
        response_type: 'code',
        code_challenge_method: 'S256',
        scope: 'sms:send payments:read invoices:read invoices:write devices:read webhooks:manage',
      },
    },
    getAccessToken: async (z: ZapierZ, bundle: ZapierBundle) => {
      const response = await z.request({
        url: 'https://api.brisksms.com/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          client_id: process.env.CLIENT_ID || 'brisksms_zapier_client',
          ...(process.env.CLIENT_SECRET ? { client_secret: process.env.CLIENT_SECRET } : {}),
          grant_type: 'authorization_code',
          code: bundle.inputData.code,
          code_verifier: bundle.inputData.code_verifier,
          redirect_uri: bundle.inputData.redirect_uri,
        },
      });

      if (response.status >= 400) {
        throw new Error(`OAuth token exchange failed with HTTP status ${response.status}`);
      }

      return unwrapEnvelope(response.json);
    },
    refreshAccessToken: async (z: ZapierZ, bundle: ZapierBundle) => {
      const response = await z.request({
        url: 'https://api.brisksms.com/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          client_id: process.env.CLIENT_ID || 'brisksms_zapier_client',
          ...(process.env.CLIENT_SECRET ? { client_secret: process.env.CLIENT_SECRET } : {}),
          grant_type: 'refresh_token',
          refresh_token: bundle.authData.refresh_token,
        },
      });

      if (response.status >= 400) {
        throw new Error(`OAuth token refresh failed with HTTP status ${response.status}`);
      }

      return unwrapEnvelope(response.json);
    },
    autoRefresh: true,
  },
  connectionLabel: '{{name}} - {{organization_id}}',
};

