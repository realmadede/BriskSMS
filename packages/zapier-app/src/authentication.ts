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

    return response.json;
  },
  oauth2Config: {
    authorizeUrl: {
      url: 'https://api.brisksms.com/oauth/authorize',
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
        url: 'https://api.brisksms.com/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          client_id: process.env.CLIENT_ID || 'brisksms_zapier_client',
          grant_type: 'authorization_code',
          code: bundle.inputData.code,
          code_verifier: bundle.inputData.code_verifier,
          redirect_uri: bundle.inputData.redirect_uri,
        },
      });

      return response.json as Record<string, unknown>;
    },
    refreshAccessToken: async (z: ZapierZ, bundle: ZapierBundle) => {
      const response = await z.request({
        url: 'https://api.brisksms.com/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          client_id: process.env.CLIENT_ID || 'brisksms_zapier_client',
          grant_type: 'refresh_token',
          refresh_token: bundle.authData.refresh_token,
        },
      });

      return response.json as Record<string, unknown>;
    },
    autoRefresh: true,
  },
  connectionLabel: '{{name}} - {{organization_id}}',
};

