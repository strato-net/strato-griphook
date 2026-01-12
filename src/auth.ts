import {
  loadCredentials,
  saveCredentials,
  refreshAccessToken,
  StoredCredentials,
} from "./login.js";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const TOKEN_REFRESH_BUFFER_MS = 120 * 1000; // Refresh 2 minutes before expiry

export class OAuthClient {
  private cachedToken: CachedToken | null = null;
  private pendingTokenRequest: Promise<string> | null = null;
  private storedCredentials: StoredCredentials | null = null;

  constructor() {
    this.storedCredentials = loadCredentials();
  }

  /**
   * Check if browser login credentials are available
   */
  hasCredentials(): boolean {
    return this.storedCredentials !== null;
  }

  async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.cachedToken.accessToken;
    }

    // Prevent concurrent token requests
    if (this.pendingTokenRequest) {
      return this.pendingTokenRequest;
    }

    this.pendingTokenRequest = this.fetchNewToken();
    try {
      const token = await this.pendingTokenRequest;
      return token;
    } finally {
      this.pendingTokenRequest = null;
    }
  }

  private async fetchNewToken(): Promise<string> {
    if (!this.storedCredentials) {
      throw new Error(
        "Not logged in. Run 'griphook login' to authenticate."
      );
    }

    const now = Date.now();

    // Check if access token is still valid
    if (now < this.storedCredentials.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      this.cachedToken = {
        accessToken: this.storedCredentials.accessToken,
        expiresAt: this.storedCredentials.expiresAt,
      };
      return this.storedCredentials.accessToken;
    }

    // Check if refresh token is still valid
    if (now >= this.storedCredentials.refreshExpiresAt) {
      throw new Error(
        "Session expired. Run 'griphook login' to re-authenticate."
      );
    }

    // Refresh the access token
    try {
      const tokens = await refreshAccessToken(
        this.storedCredentials.openIdDiscoveryUrl,
        this.storedCredentials.clientId,
        this.storedCredentials.refreshToken,
        this.storedCredentials.clientSecret
      );

      // Update stored credentials
      this.storedCredentials = {
        ...this.storedCredentials,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        refreshExpiresAt: Date.now() + (tokens.refresh_expires_in || 86400) * 1000,
      };

      // Save updated credentials
      saveCredentials(this.storedCredentials);

      this.cachedToken = {
        accessToken: tokens.access_token,
        expiresAt: this.storedCredentials.expiresAt,
      };

      return tokens.access_token;
    } catch (err) {
      throw new Error(
        `Failed to refresh token: ${err instanceof Error ? err.message : err}. Run 'griphook login' to re-authenticate.`
      );
    }
  }

  /**
   * Decode and return the username from the JWT token payload
   */
  async getUsername(): Promise<string> {
    const token = await this.getAccessToken();
    try {
      const payload = token.split(".")[1];
      if (!payload) throw new Error("Invalid JWT (missing payload)");
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return decoded.preferred_username || decoded.email || decoded.sub;
    } catch (err) {
      throw new Error(
        `Failed to decode access token payload: ${err instanceof Error ? err.message : err}. Run 'griphook login' to refresh credentials.`,
      );
    }
  }

  /**
   * Clear cached token (useful for forcing re-authentication)
   */
  clearCache(): void {
    this.cachedToken = null;
  }
}
