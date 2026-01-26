import axios, { AxiosInstance, AxiosError, Method } from "axios";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { GriphookConfig } from "./config.js";
import { OAuthClient } from "./auth.js";
import { getRequestAccessToken } from "./requestContext.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/**
 * STRATO API error response structure
 */
interface StratoErrorResponse {
  error?: {
    message?: string;
    status?: number;
    type?: string;
    details?: {
      code?: string;
      hint?: string;
      details?: string;
      path?: string;
    };
  };
  message?: string;
}

export class GriphookClient {
  private http: AxiosInstance;
  private oauth: OAuthClient;

  constructor(config: GriphookConfig) {
    this.oauth = new OAuthClient();
    this.http = axios.create({
      baseURL: config.apiBaseUrl,
      timeout: config.timeoutMs,
    });
  }

  async request<T = unknown>(method: HttpMethod, path: string, options?: {
    params?: Record<string, unknown>;
    data?: unknown;
    headers?: Record<string, string>;
  }): Promise<T> {
    const url = path.startsWith("/") ? path : `/${path}`;
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };

    // In hosted mode, use the request-scoped access token from the middleware.
    // Fall back to local OAuth credentials for CLI/stdio mode.
    const requestToken = getRequestAccessToken();
    const token = requestToken ?? await this.oauth.getAccessToken();
    headers["x-user-access-token"] = token;
    headers["authorization"] = `Bearer ${token}`;

    try {
      const response = await this.http.request<T>({
        method: method as Method,
        url,
        params: options?.params,
        data: options?.data,
        headers,
      });
      return response.data;
    } catch (err) {
      throw new McpError(ErrorCode.InternalError, this.formatAxiosError(err));
    }
  }

  /**
   * Get the authenticated username from the OAuth token
   */
  async getUsername(): Promise<string> {
    return this.oauth.getUsername();
  }

  /**
   * Format Axios errors into detailed, actionable error messages.
   * Handles STRATO's nested error response structure:
   * - StratoError: { error: { message, status, type } }
   * - CirrusError: { error: { message, status, type, details: { code, hint } } }
   * - ValidationError, AuthError, etc.
   */
  private formatAxiosError(err: unknown): string {
    if (!axios.isAxiosError(err)) {
      return err instanceof Error ? err.message : "Unknown error";
    }

    const axiosErr = err as AxiosError<StratoErrorResponse>;
    const status = axiosErr.response?.status;
    const data = axiosErr.response?.data;

    // No response data - network error or timeout
    if (!data) {
      if (axiosErr.code === "ECONNABORTED") {
        return `Request timeout: The server took too long to respond`;
      }
      if (axiosErr.code === "ENOTFOUND" || axiosErr.code === "ECONNREFUSED") {
        return `Connection failed: Unable to reach the STRATO API`;
      }
      return `Network error: ${axiosErr.message}`;
    }

    // Handle nested error object from STRATO backend
    const errorObj = data.error;
    if (typeof errorObj === "object" && errorObj !== null) {
      const parts: string[] = [];

      // Error type (StratoError, CirrusError, ValidationError, etc.)
      if (errorObj.type) {
        parts.push(`[${errorObj.type}]`);
      }

      // Main error message
      if (errorObj.message) {
        parts.push(errorObj.message);
      }

      // Additional details for CirrusError (database errors)
      if (errorObj.details) {
        const { code, hint, details: extraDetails } = errorObj.details;
        if (code) parts.push(`(code: ${code})`);
        if (hint) parts.push(`Hint: ${hint}`);
        if (extraDetails) parts.push(`Details: ${extraDetails}`);
      }

      if (parts.length > 0) {
        return `HTTP ${status}: ${parts.join(" ")}`;
      }
    }

    // Handle plain string error
    if (typeof errorObj === "string") {
      return `HTTP ${status}: ${errorObj}`;
    }

    // Fallback to top-level message
    if (data.message) {
      return `HTTP ${status}: ${data.message}`;
    }

    // Last resort - use axios message
    return `HTTP ${status ?? "request failed"}: ${axiosErr.message}`;
  }
}
