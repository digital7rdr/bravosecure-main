import {Injectable, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';

export interface DiscoveredContact {
  /** The phone the client queried with — echoed so the client can key its UI. */
  phone:        string;
  userId:       string;
  displayName:  string;
  avatarUrl:    string | null;
}

export interface Me {
  id:                    string;
  displayName:           string;
  phoneE164:             string | null;
  email:                 string;
  bio:                   string | null;
  avatarUrl:             string | null;
  lastSeenVisible:       boolean;
  readReceiptsEnabled:   boolean;
  // Step 25 — preferences.
  language:              string;
  currency:              string | null;
  notifPrefs:            Record<string, boolean>;
  locationScope:         string;
  appLock:               boolean;
  homeRegion:            string | null;
}

interface UserRow {
  id:            string;
  phone_e164:    string;
  display_name:  string;
  avatar_url:    string | null;
}

interface MeRow {
  id:                     string;
  display_name:           string;
  email:                  string;
  phone_e164:             string | null;
  bio:                    string | null;
  avatar_url:             string | null;
  last_seen_visible:      boolean;
  read_receipts_enabled:  boolean;
  language:               string;
  currency:               string | null;
  notif_prefs:            Record<string, boolean> | null;
  location_scope:         string;
  app_lock:               boolean;
  home_region:            string | null;
}

/**
 * Phone-number directory lookups, profile self-management, and the
 * blocked-users list.
 *
 * Privacy model (Phase-1):
 *  - All endpoints JWT-gated.
 *  - Lookup never leaks negatives (only returns matches).
 *  - Lookup filters bidirectionally on the `blocked_users` table so a
 *    block silently hides both parties from each other's directory.
 *  - Reads the caller's own profile + privacy flags in one round-trip.
 *
 * M2 upgrade (spec §D2): client hashes phones before sending. Plaintext
 * over TLS is acceptable for Phase-1.
 */
@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  async lookupByPhones(phones: string[], callerId: string): Promise<DiscoveredContact[]> {
    const unique = Array.from(new Set(phones));
    if (unique.length === 0) return [];

    // Two-sided block filter: exclude users who the caller blocked, AND
    // users who blocked the caller. The PKs are directed, so both
    // directions need an explicit NOT EXISTS.
    const rows = await this.db.q<UserRow>(
      `SELECT u.id, u.phone_e164, u.display_name, u.avatar_url
         FROM public.users u
        WHERE u.phone_e164 = ANY($1)
          AND u.id <> $2
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.blocked_users b
             WHERE (b.blocker_user_id = $2 AND b.blocked_user_id = u.id)
                OR (b.blocker_user_id = u.id AND b.blocked_user_id = $2)
          )`,
      [unique, callerId],
    );

    rows.push(...(await this.lookupLegacyNationalFormat(unique, rows, callerId)));

    return rows.map(r => ({
      phone:       r.phone_e164,
      userId:      r.id,
      displayName: r.display_name,
      avatarUrl:   r.avatar_url,
    }));
  }

  /**
   * B-246 — rescue lookups for rows that predate E.164 normalisation at
   * registration and store the number in NATIONAL format ("01878547473",
   * "0507356048"). An exact match can never find them: the searcher types the
   * correct "+8801878547473", it normalises correctly, and the lookup returns
   * nothing — reported as "no account found on Bravo" for an account that
   * plainly exists.
   *
   * THE PRECEDENCE RULE IS THE WHOLE SAFETY ARGUMENT. This runs only for
   * candidates that matched NOTHING exactly. Real collisions exist in prod:
   * "0507356048" (a legacy row) shares its national number with
   * "+971507356048", which belongs to a DIFFERENT user. Matching nationals
   * unconditionally would return both and let the client open a chat with the
   * wrong person — a worse bug than the one being fixed, in an app where
   * picking the wrong recipient leaks a message. An exact hit always wins, so
   * a correct number can never resolve to someone else.
   *
   * Restricted further to rows that are themselves malformed, so well-formed
   * rows keep strict exact matching. Needs no country attribution — just as
   * well, since two of the drift rows are genuinely ambiguous ("050…" is UAE
   * or Saudi, "072…" is South Africa or UK) and `home_region` is populated for
   * exactly one user. Self-healing: matches nothing once the rows are fixed.
   */
  private async lookupLegacyNationalFormat(
    candidates: string[],
    exactHits: UserRow[],
    callerId: string,
  ): Promise<UserRow[]> {
    const national = (v: string) => v.replace(/[^\d]/g, '').replace(/^0+/, '');
    const matched = new Set(exactHits.map(r => r.phone_e164));

    const unmatched = Array.from(new Set(
      candidates
        .filter(p => !matched.has(p))
        .map(national)
        // 8-digit floor: short enough for every real subscriber number, long
        // enough that a stray typo can't reach the junk rows in the table.
        .filter(d => d.length >= 8),
    ));
    if (unmatched.length === 0) return [];

    const alreadyFound = exactHits.map(r => r.id);
    return (await this.db.q<UserRow>(
      `SELECT u.id, u.phone_e164, u.display_name, u.avatar_url
         FROM public.users u
        WHERE u.phone_e164 !~ '^\\+'
          AND regexp_replace(regexp_replace(u.phone_e164, '[^0-9]', '', 'g'), '^0+', '') = ANY($1)
          AND u.id <> $2
          AND NOT (u.id = ANY($3::uuid[]))
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.blocked_users b
             WHERE (b.blocker_user_id = $2 AND b.blocked_user_id = u.id)
                OR (b.blocker_user_id = u.id AND b.blocked_user_id = $2)
          )`,
      [unmatched, callerId, alreadyFound],
    )) ?? [];
  }

  /**
   * Batch fetch public profile fields by userId — for rendering member
   * avatars in chat info / group screens where the caller has userIds
   * (not phones). Same two-sided block filter as lookupByPhones so a
   * blocked user's avatar never leaks. Unknown / deleted / blocked ids
   * are simply omitted from the result.
   */
  async getProfilesByIds(
    userIds: string[],
    callerId: string,
  ): Promise<Array<{userId: string; displayName: string; avatarUrl: string | null}>> {
    const unique = Array.from(new Set(userIds));
    if (unique.length === 0) return [];

    const rows = await this.db.q<{id: string; display_name: string; avatar_url: string | null}>(
      `SELECT u.id, u.display_name, u.avatar_url
         FROM public.users u
        WHERE u.id = ANY($1)
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.blocked_users b
             WHERE (b.blocker_user_id = $2 AND b.blocked_user_id = u.id)
                OR (b.blocker_user_id = u.id AND b.blocked_user_id = $2)
          )`,
      [unique, callerId],
    );

    return rows.map(r => ({
      userId:      r.id,
      displayName: r.display_name,
      avatarUrl:   r.avatar_url,
    }));
  }

  async getMe(userId: string): Promise<Me> {
    const row = await this.db.qOne<MeRow>(
      `SELECT id, display_name, email, phone_e164, bio, avatar_url,
              last_seen_visible, read_receipts_enabled,
              language, currency, notif_prefs, location_scope, app_lock, home_region
         FROM public.users
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!row) throw new NotFoundException('user_not_found');
    return {
      id:                  row.id,
      displayName:         row.display_name,
      email:               row.email,
      phoneE164:           row.phone_e164,
      bio:                 row.bio,
      avatarUrl:           row.avatar_url,
      lastSeenVisible:     row.last_seen_visible,
      readReceiptsEnabled: row.read_receipts_enabled,
      language:            row.language,
      currency:            row.currency,
      // Safety is always on (server-forced) even if a legacy row predates the column.
      notifPrefs:          {...(row.notif_prefs ?? {}), safety: true},
      locationScope:       row.location_scope,
      appLock:             row.app_lock,
      homeRegion:          row.home_region,
    };
  }

  async updateMe(userId: string, patch: {displayName?: string; bio?: string; avatarUrl?: string | null}): Promise<Me> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.displayName !== undefined) push('display_name', patch.displayName);
    if (patch.bio         !== undefined) push('bio',          patch.bio);
    if (patch.avatarUrl   !== undefined) push('avatar_url',   patch.avatarUrl);
    if (sets.length === 0) return this.getMe(userId);
    params.push(userId);
    await this.db.q(
      `UPDATE public.users SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length} AND deleted_at IS NULL`,
      params,
    );
    return this.getMe(userId);
  }

  async updatePrivacy(
    userId: string,
    patch: {lastSeenVisible?: boolean; readReceiptsEnabled?: boolean},
  ): Promise<Me> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.lastSeenVisible      !== undefined) { params.push(patch.lastSeenVisible);      sets.push(`last_seen_visible      = $${params.length}`); }
    if (patch.readReceiptsEnabled  !== undefined) { params.push(patch.readReceiptsEnabled);  sets.push(`read_receipts_enabled  = $${params.length}`); }
    if (sets.length === 0) return this.getMe(userId);
    params.push(userId);
    await this.db.q(
      `UPDATE public.users SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length} AND deleted_at IS NULL`,
      params,
    );
    return this.getMe(userId);
  }

  async updatePreferences(
    userId: string,
    patch: {
      language?: string; currency?: string;
      notifPrefs?: Record<string, boolean>; locationScope?: string; appLock?: boolean;
      homeRegion?: string;
    },
  ): Promise<Me> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (patch.language      !== undefined) push('language',       patch.language);
    if (patch.currency      !== undefined) push('currency',       patch.currency);
    if (patch.locationScope !== undefined) push('location_scope', patch.locationScope);
    if (patch.appLock       !== undefined) push('app_lock',       patch.appLock);
    if (patch.homeRegion    !== undefined) push('home_region',    patch.homeRegion);
    if (patch.notifPrefs    !== undefined) {
      // Sanitize to a boolean-only category map (drop any non-boolean value a client
      // sends so the JSONB column keeps its Record<string, boolean> contract), then
      // FORCE safety ON — a user can never silence a safety-critical alert (the getMe
      // read also re-forces it).
      const clean: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(patch.notifPrefs)) {
        if (typeof v === 'boolean') {clean[k] = v;}
      }
      push('notif_prefs', JSON.stringify({...clean, safety: true}));
      // The JSONB column needs an explicit cast on the bound param.
      sets[sets.length - 1] = `notif_prefs = $${params.length}::jsonb`;
    }
    if (sets.length === 0) return this.getMe(userId);
    params.push(userId);
    await this.db.q(
      `UPDATE public.users SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length} AND deleted_at IS NULL`,
      params,
    );
    return this.getMe(userId);
  }

  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) return;
    await this.db.q(
      `INSERT INTO public.blocked_users (blocker_user_id, blocked_user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [blockerId, blockedId],
    );
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.db.q(
      `DELETE FROM public.blocked_users
        WHERE blocker_user_id = $1 AND blocked_user_id = $2`,
      [blockerId, blockedId],
    );
  }

  async listBlocked(blockerId: string): Promise<Array<{userId: string; displayName: string; avatarUrl: string | null}>> {
    const rows = await this.db.q<{id: string; display_name: string; avatar_url: string | null}>(
      `SELECT u.id, u.display_name, u.avatar_url
         FROM public.blocked_users b
         JOIN public.users u ON u.id = b.blocked_user_id
        WHERE b.blocker_user_id = $1 AND u.deleted_at IS NULL
        ORDER BY b.created_at DESC`,
      [blockerId],
    );
    return rows.map(r => ({userId: r.id, displayName: r.display_name, avatarUrl: r.avatar_url}));
  }
}
