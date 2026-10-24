// Hand-written declarations. The SDK is plain ES modules with no build step,
// so there is nothing to generate these from; they are part of the published
// contract and are kept beside the code they describe.

export interface DiscoveryOptions {
  /**
   * Permit plaintext `http://` / `ws://` for local development ONLY. The
   * long-lived bot token is sent to the bot home, so turning this on in
   * production puts that credential on the wire in the clear. Defaults to the
   * `TELIUM_BOT_INSECURE_ALLOW_PLAINTEXT_HTTP` environment variable.
   */
  allowInsecureHttp?: boolean;
  /**
   * The domain the caller believes it is contacting. When given, the
   * discovery document's `server_name` must match it or discovery fails.
   */
  expectServerName?: string;
  /** Per-request timeout in milliseconds; `false` disables it. */
  timeoutMs?: number | false;
}

export interface DiscoveredServer {
  /** The peer's self-described name, already checked against `domain`. */
  serverName?: string;
  /** The domain actually dialled — the only safe basis for an audience. */
  domain: string;
  /** `https://…` API base, confined to `domain` or a delegation beneath it. */
  api: string;
  /** `wss://…` gateway, confined the same way. */
  gateway: string;
}

export const INSECURE_HTTP_ENV: string;
export const BOT_NOT_INSTALLED_CODE: string;
export const UNKNOWN_BOT_TOKEN_CODE: string;
export const BOT_CREDENTIAL_REVOKED_CODE: string;
export function isDeadCredential(error: unknown): boolean;
export const AUTH_RETRY_LIMIT: number;

export function discover(server: string, options?: DiscoveryOptions): Promise<DiscoveredServer>;
export function requireGatewayUrl(
  value: string,
  dialled: string,
  options?: { allowInsecureHttp?: boolean },
): string;

export function isNotInstalled(error: unknown): boolean;
export function isAuthError(error: unknown): boolean;
export function isTerminalHttpError(error: unknown): boolean;

export interface BotClientOptions {
  /** The bot's identity home: a bare domain, or an explicit https URL. */
  home: string;
  /** The long-lived bot token. Sent only to `home`. */
  token: string;
  intents?: string[];
  /** Installation index poll interval; `false` disables polling. */
  installationRefreshMs?: number | false;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number | false;
  /** Consecutive authorisation failures tolerated per domain. */
  authRetryLimit?: number;
}

export interface Installation {
  guild_id: string;
  guild_domain: string;
  installed_at?: number;
  allowed_intents?: string | number;
  permissions?: string | number;
  [key: string]: unknown;
}

export interface BotWarning {
  code: string;
  message: string;
  domain?: string;
  phase?: string;
  status?: number;
  attempt?: number;
  limit?: number;
  cause?: unknown;
  [key: string]: unknown;
}

export type Unsubscribe = () => void;

export class BotClient {
  constructor(options: BotClientOptions);

  readonly home: string;
  readonly intents: string[];
  installations: Installation[];
  homeInfo: DiscoveredServer | null;

  on(event: 'warning', handler: (warning: BotWarning) => unknown): Unsubscribe;
  on(event: 'error', handler: (error: unknown, context?: Record<string, unknown>) => unknown): Unsubscribe;
  on(event: string, handler: (...args: any[]) => unknown): Unsubscribe;

  emit(event: string, ...args: unknown[]): void;

  login(): Promise<this>;
  close(): void;

  sendMessage(
    channelId: string,
    content: string,
    options?: { domain?: string },
  ): Promise<unknown>;

  fetchInstallations(): Promise<Installation[]>;
  refreshInstallations(options?: { phase?: string }): Promise<{
    connectedDomains: string[];
    unavailableDomains: string[];
  }>;
}
