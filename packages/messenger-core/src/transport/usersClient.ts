/**
 * HTTP adapter for auth-service's directory lookups.
 *
 *   POST /users/lookup   — body: {phones: string[]}
 *                          returns: {matches: DiscoveredContact[]}
 *
 * JWT-gated on the server; a missing/invalid token raises 401 and the
 * caller should redirect to sign-in rather than retry.
 *
 * Server rate-limits this to 20 req/hr/IP, so callers should batch
 * (up to 500 phones per call) rather than chatter.
 */
import {fetchWithTimeout} from './fetchWithTimeout';

export interface DiscoveredContact {
  /** The exact phone the client queried with — echoed so UI can key off it. */
  phone:       string;
  userId:      string;
  displayName: string;
  avatarUrl:   string | null;
}

/** Public profile fields fetched by userId (POST /users/profiles). */
export interface UserProfile {
  userId:      string;
  displayName: string;
  avatarUrl:   string | null;
}

export interface UsersHttpClientOptions {
  /** Auth-service base URL, e.g. http://10.0.2.2:3001 */
  baseUrl:  string;
  getToken: () => Promise<string | null>;
  /** Fix #19: optional refresh-on-401 — see relayClient for rationale. */
  refreshToken?: () => Promise<void>;
}

export class UsersHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'UsersHttpError';
  }
}

export interface Me {
  id:                   string;
  displayName:          string;
  phoneE164:            string | null;
  email:                string;
  bio:                  string | null;
  avatarUrl:            string | null;
  lastSeenVisible:      boolean;
  readReceiptsEnabled:  boolean;
}

export interface BlockedUser {
  userId:      string;
  displayName: string;
  avatarUrl:   string | null;
}

export class UsersHttpClient {
  constructor(private readonly opts: UsersHttpClientOptions) {}

  /**
   * Batch-lookup a list of E.164 phones. The server silently drops
   * invalid entries, so callers should normalize client-side first
   * (see `contacts/phoneNormalize.ts`).
   *
   * Response contains ONLY matches — unknown phones don't appear.
   * Clients subtract the returned set from the submitted set to
   * discover which contacts are NOT on the platform.
   */
  async lookup(phones: string[]): Promise<DiscoveredContact[]> {
    if (phones.length === 0) {return [];}
    const resp = await this.request<{matches: DiscoveredContact[]}>(
      'POST',
      '/users/lookup',
      {phones},
    );
    return resp.matches ?? [];
  }

  /**
   * Batch fetch public profile fields (displayName, avatarUrl) by userId.
   * For rendering member avatars in chat info / group screens where we
   * hold userIds but not phones. Unknown / blocked ids are omitted.
   * Chunks at 500 to respect the server cap.
   */
  async getProfilesByIds(userIds: string[]): Promise<UserProfile[]> {
    const unique = Array.from(new Set(userIds));
    if (unique.length === 0) {return [];}
    const out: UserProfile[] = [];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const resp = await this.request<{profiles: UserProfile[]}>(
        'POST', '/users/profiles', {userIds: chunk},
      );
      out.push(...(resp.profiles ?? []));
    }
    return out;
  }

  async me(): Promise<Me> {
    return this.request<Me>('GET', '/users/me');
  }

  async updateMe(patch: {displayName?: string; bio?: string; avatarUrl?: string | null}): Promise<Me> {
    return this.request<Me>('PATCH', '/users/me', patch);
  }

  async updatePrivacy(patch: {lastSeenVisible?: boolean; readReceiptsEnabled?: boolean}): Promise<Me> {
    return this.request<Me>('PATCH', '/users/me/privacy', patch);
  }

  async block(userId: string): Promise<void> {
    await this.request('POST', '/users/block', {userId});
  }

  async unblock(userId: string): Promise<void> {
    await this.request('DELETE', `/users/block/${encodeURIComponent(userId)}`);
  }

  async listBlocked(): Promise<BlockedUser[]> {
    const resp = await this.request<{blocked: BlockedUser[]}>('GET', '/users/blocked');
    return resp.blocked ?? [];
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Fix #19: retry once on 401 after a token refresh.
    const send = async (): Promise<Response> => {
      const token = await this.opts.getToken();
      if (!token) {throw new UsersHttpError(401, 'no_token');}
      return fetchWithTimeout(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    let res = await send();
    if (res.status === 401 && this.opts.refreshToken) {
      try { await this.opts.refreshToken(); res = await send(); } catch { /* fall through */ }
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = typeof parsed === 'object' && parsed && 'message' in parsed
        ? String((parsed as {message: unknown}).message)
        : text || res.statusText;
      throw new UsersHttpError(res.status, msg);
    }
    return (parsed ?? {}) as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
