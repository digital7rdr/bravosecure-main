import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {BottomTabScreenProps} from '@react-navigation/bottom-tabs';
import type {CompositeScreenProps, NavigatorScreenParams} from '@react-navigation/native';
import type {
  AttendanceStatusDto, ReviewReasonDto,
  IncidentCategoryDto, IncidentSeverityDto, IncidentStatusDto, IncidentReportDto,
  OrgMissionDto, ShiftDto, ShiftSessionDto,
} from '@services/api';
// B-302 — the escalation route handover. `callAudioRoute` is a pure module with
// zero imports, so referencing it here cannot create a navigation import cycle.
import type {AudioRoute} from '@/modules/messenger/runtime/callAudioRoute';

// ─── Auth Stack ───────────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Splash: undefined;
  Onboarding: undefined;
  Login: undefined;
  Register: {role: 'individual' | 'corporate' | 'agent'; tier?: 'lite' | 'pro' | 'enterprise'} | undefined;
  OTPVerification: {
    phone: string;
    mode: 'login' | 'register';
    // Pending signup payload — present only when mode === 'register'.
    email?: string;
    password?: string;
    fullName?: string;
    // Mirrors Register / SignupSuccess and the authStore register action,
    // which all accept 'agent'. OTPVerification forwards this straight into
    // register(), so the value must flow through rather than be narrowed away.
    role?: 'individual' | 'corporate' | 'agent';
    tier?: 'lite' | 'pro' | 'enterprise';
  };
  // IDN-12/28 — login OTP entry when /auth/login returns no devOtpCode
  // (live Twilio delivery). userId comes from the login response.
  OtpVerify: {userId: string; phoneHint?: string};
  RoleSelection: undefined;
  ProfileCompletion: undefined;
  HomeSelection: undefined;
  SignupSuccess: {fullName: string; role: 'individual' | 'corporate' | 'agent'; tier?: 'lite' | 'pro' | 'enterprise'};
  Permissions: undefined;
};

// ─── Main Bottom Tabs ─────────────────────────────────────────────────────────

export type MainTabParamList = {
  Dashboard: undefined;
  MessengerTab: NavigatorScreenParams<MessengerStackParamList> | undefined;
  SecureTab: NavigatorScreenParams<BookingStackParamList> | NavigatorScreenParams<AgentStackParamList> | undefined;
  NewsTab: NavigatorScreenParams<NewsStackParamList> | undefined;
  ProfileTab: undefined;
};

// ─── Messenger Stack ─────────────────────────────────────────────────────────

/**
 * B-453 — where to land once the vault gate clears.
 *
 * The on-device Files browser is gated by the same PIN now, so the lock and
 * setup screens can no longer assume the cloud vault is the destination:
 * a user who tapped Files must come back to Files, not to a Cloud Vault they
 * may not even be entitled to. Absent = the vault, which is `openVault`'s
 * path and every pre-B-453 caller.
 *
 * The two FilesScreen names are the two routes FilesScreen is registered under
 * — `Files` in the messenger and agent stacks, `MessengerHome` in the
 * workspace Vault tab (see `DeptVaultStackParamList`).
 *
 * `MessengerSettings` is the third, and it is NOT a FilesScreen alias: it is
 * the Settings pane's biometric toggle sending the user to prove their PIN and
 * come straight back. It is legal in this union only because the route is now
 * registered in EVERY shell that mounts VaultLock/VaultNewPin (messenger,
 * agent, workspace Vault) — see the F-WSHUB note below: a declared-but-
 * unregistered name is a bare navigate that compiles and silently no-ops.
 */
export type VaultGateParams = {next?: 'Files' | 'MessengerHome' | 'MessengerSettings'} | undefined;

/**
 * B-696 Phase C — the REAL Forgot-PIN flow (audit S2 closure; design doc
 * VAULT_DURABILITY_DESIGN_2026-08-29 §5). The lane threads `next` end-to-end
 * so the user lands back where the lock gated them, `maskedPhone` labels the
 * OTP screen with the account phone the server actually texted, and
 * `resetToken` is the server-minted single-use proof VaultNewPin exchanges
 * for a new verifier. All three shells register these routes (the
 * vaultBiometricToggle cross-shell sweep keeps that honest).
 */
export type VaultOtpVerifyParams = ({next?: 'Files' | 'MessengerHome' | 'MessengerSettings'; maskedPhone?: string}) | undefined;
export type VaultNewPinParams = ({next?: 'Files' | 'MessengerHome' | 'MessengerSettings'; resetToken?: string}) | undefined;

/**
 * The tabs MessengerHome renders INLINE under its persistent footer (N1). The
 * pushed Files screen hosts the same footer and hands one of these back as a
 * route param when a tab is pressed there (consumed once, then cleared).
 */
export type MessengerHomeTab = 'Chats' | 'Calls' | 'News';

export type MessengerStackParamList = {
  MessengerHome: {tab?: MessengerHomeTab} | undefined;
  Chat: {conversationId: string; name: string; isGroup: boolean; draft?: string; focusMessageId?: string};
  VaultLock: VaultGateParams;
  // `addToGroupId` (+ name) puts NewChat in "add member to existing group"
  // mode: picking a contact calls runtime.addGroupMember instead of opening
  // a new chat. Undefined param = normal new-message / new-group flow.
  NewChat: {addToGroupId: string; groupName: string} | undefined;
  VaultScreen: undefined;
  FileVaultPurchase: undefined;
  VaultForgot: VaultGateParams;
  VaultOTPVerify: VaultOtpVerifyParams;
  VaultNewPin: VaultNewPinParams;
  CallsLog: undefined;
  Links: undefined;
  /** Client 2026-08-22 — the Calls header Emergency door (VBGEmergencyScreen). */
  EmergencyServices: {countryIso?: string; countryName?: string} | undefined;
  Groups: undefined;
  ChatInfo: {conversationId: string};
  Files: undefined;
  DepartmentChannels: undefined;
  DepartmentChat: {
    channelId: string;
    channelName: string;
    channelDesc: string;
    /** Messenger group conversation id carrying the E2EE posts. May be null
     *  if the channel's Signal group hasn't been bootstrapped yet. */
    groupConversationId?: string | null;
    myRole?: 'admin' | 'viewer';
    /** True when the viewer created the channel — gates owner-only delete. */
    isOwner?: boolean;
    /** Scope v2 Phase 2 — posting mode. Anything other than 'open' turns on
     *  receive-side rejection of posts from non-posters (A9/M9), which is how
     *  read-only is enforced without the sealed-sender relay knowing senders. */
    postMode?: 'open' | 'read_only' | 'announcement' | 'admin_only';
  };
  // Manager channel management (Step 18). ChannelEditor with no `channel` = create.
  ManageChannels: undefined;
  /** M1A rule 16 — Enterprise workspace employee roster (add/suspend/remove). */
  Employees: undefined;
  /** Scope v2 Phase 3 — A11 admin inbox for join requests. */
  Approvals: undefined;
  /** M5 — apply to a workspace. `code` arrives from a shared referral link. */
  JoinWorkspace: {code?: string} | undefined;
  /** A4/M4 — the Enterprise create-or-join fork, asked AFTER auth. */
  EnterpriseSetup: undefined;
  /** A5 — name and create the workspace. */
  CreateWorkspace: undefined;
  /** M11A — the applicant's own request status (and Item E invitee surface). */
  ApprovalStatus: undefined;
  /** Item E (A5-inv) — admin mints a bound phone/email invite. `channelId`
   *  pre-selects the team when arriving from ChannelMembersScreen. */
  InviteMember: {channelId?: string} | undefined;
  // Reached from a department-chat message avatar. Declared in every shell that
  // mounts DepartmentChat, otherwise the tap bubbles to an ancestor that has no
  // such route and is silently swallowed.
  OrgCpoProfile: {memberUserId: string; displayName?: string | null};
  /** M1A rule 16 — the full dept workspace shell (attendance + incidents +
   *  channels tabs), the same navigator providers mount. */
  Departmental: undefined;
  /** F-WSHUB — the workspace list page (own workspace · member-of · invites). */
  WorkspaceHub: undefined;
  ChannelEditor: {
    channel?: {
      id: string;
      name: string;
      department: string | null;
      channel_type: 'board' | 'department' | 'incident';
      access: 'standard' | 'read_only' | 'restricted';
      archived: boolean;
      /** Phase 2 — required for a lossless round-trip: `access` alone cannot
       *  distinguish Standard from Read only (both store 'standard'). */
      post_mode?: 'open' | 'read_only' | 'announcement' | 'admin_only';
      is_broadcast?: boolean;
      /**
       * UI corrections 2026-08-15 item 04 — is this a LATERAL channel?
       *
       * Required on the EDIT path, not just create: without it the editor cannot
       * tell a lateral from a level node, so it can offer neither the
       * lateral-only "Announcements" access option nor the "Lateral channel in
       * X" placement line. Absent = an old caller or an old server, which reads
       * as "structural" — exactly today's behaviour.
       */
      is_lateral?: boolean;
      /** vs2 edge A4 — the server's per-row delete verdict, carried through so
       *  the editor's Members door can offer Delete. */
      deletable?: boolean;
    };
    /**
     * item 04 — create this as a LATERAL of `parentId` (same level, no new tier).
     * Distinct from `parentId` alone, which still means a structural sub-level.
     */
    lateral?: boolean;
    /** vs2 items 7+8 — WHERE the new channel goes, decided by the tree node the
     *  admin tapped rather than re-asked as a picker. `parentName` is display
     *  only; `root` means "a new organisation", which is NOT the same as simply
     *  omitting parentId (on a legacy flat workspace that would produce yet
     *  another level-1 Main instead of a true level-0 root). */
    parentId?: string;
    parentName?: string;
    root?: boolean;
    /** vs2 edge A3 — is the ORG BEING ADMINISTERED a workspace tenant? Handed
     *  down from `listManagedChannels` (ManageChannels is the only door here),
     *  because the editor's own `isWorkspaceTenant` is a USER-level fact and is
     *  wrong for an agency manager who has also joined a workspace — it dropped
     *  the DEPARTMENT field and created agency channels with `department=null`.
     *  Absent → fall back to that user-level flag (old server / old caller). */
    workspaceTenant?: boolean;
  } | undefined;
  /**
   * vs2 edge A4 — `canDelete`, not `isOwner`.
   *
   * The old name was a CLIENT GUESS about identity, and the manage path never
   * passed it at all, so the PDF's Delete ask had no door: even the workspace
   * owner never saw the button on the admin flow. It is now the SERVER's
   * per-row verdict (creator, or the workspace owner) — one fact, one name,
   * both doors. Absent → no Delete, which is what every old caller did.
   */
  ChannelMembers: {channelId: string; channelName: string; canDelete?: boolean; groupConversationId?: string};
  VoiceCall: {conversationId: string; name: string};
  CallScreen: {
    conversationId: string;
    callType: 'voice' | 'video';
    isIncoming: boolean;
    remoteUserId?: string;
    /**
     * Required for a real WebRTC call. Outgoing calls generate a fresh
     * id at the call site; incoming calls get the id from `call.offer`.
     * Routes that omit this fall back to demo-only mode.
     */
    callId?: string;
    /** Required for incoming — the offer SDP from `call.offer.from`. */
    remoteDeviceId?: number;
    incomingSdp?: string;
    /**
     * P1-BR-2 — set when the user answered from the notification/Telecom
     * surface. CallScreen auto-accepts as soon as the offer SDP is present
     * (including a queued offer replayed over the reconnecting WS) instead
     * of showing a second in-app Accept button.
     */
    autoAccept?: boolean;
  };
  /** mediasoup SFU group call (3+ participants). Bypasses CallScreen. */
  GroupCallScreen: {
    conversationId: string;
    callType: 'voice' | 'video';
    /**
     * `outgoing` rings everyone via sfu.ring; `incoming` joins straight
     * in (the IncomingGroupCallScreen already handled the ring).
     */
    direction: 'outgoing' | 'incoming';
    /** Optional: join an existing room. Omit to create one. */
    roomId?: string;
    /** Other group members to ring (exclude self). */
    recipientUserIds: string[];
    /** Display label shown in recipients' incoming ring UI. */
    callerName: string;
    /**
     * B-302 — the audio route the call is ALREADY on, handed over when a 1:1
     * escalates here via `navigation.replace`. That replace unmounts CallScreen
     * and takes its `preferredRouteRef` with it, so without this the fresh
     * screen starts with no preference and the first device event auto-snaps to
     * whatever headset is attached — silently overriding a route the user
     * explicitly chose. Absent for calls that did not come from an escalation.
     */
    initialAudioRoute?: AudioRoute;
    /**
     * B-301 — the callId of a 1:1 that is still LIVE behind an escalation.
     * `escalateToGroupCall` no longer hangs the 1:1 up before navigating (that
     * was irreversible and happened before the SFU room existed, so a room that
     * never formed lost the call). CallScreen's `beforeRemove` minimizes it
     * instead, and this screen ends it once the room is genuinely joined —
     * making escalation atomic. Absent for calls that did not come from one.
     */
    pendingDirectCallId?: string;
    /**
     * BS-CALL-ADHOC — the host/owner userId of an ad-hoc ('Call') group.
     * The host files the call master key under `direct:<owner>` on every
     * recipient (productionRuntime alias). The joiner must look the key
     * up under that SAME id, not its own asymmetric `conversationId`
     * (which is the host's local thread key and means a different user on
     * the joiner's device). Set on the incoming path from the ring's
     * `from.userId`; absent on the outgoing/host path (host owns it).
     */
    hostUserId?: string;
    /**
     * Audit P0-C2 / row #5 — per-caller HMAC room-access token.
     * Incoming path: from `sfu.ring.incoming` via IncomingGroupCall-
     * Screen. Outgoing path: host obtains its own from `POST /sfu/
     * rooms` (or 2nd-member via GET /sfu/rooms/by-conversation).
     */
    roomToken?: string;
  };
  /** Incoming group-call ring UI — accept/decline. */
  IncomingGroupCallScreen: {
    roomId:         string;
    conversationId: string;
    callType:       'voice' | 'video';
    callerName:     string;
    fromUserId:     string;
    /** Audit P0-C2 / row #5 — token to echo back in sfu.join + decline. */
    roomToken?:     string;
    /**
     * P1-BR-1 / P1-BR-2 — set when the user answered the group ring from the
     * notification. IncomingGroupCallScreen joins the room directly instead
     * of waiting on a second in-app Accept.
     */
    autoAccept?:    boolean;
    /**
     * WI-6.7 — the fan-out THIS ring belongs to (B-336 mint). The screen's
     * cancel handler matches on it so a stale cancel for an OLDER ring of
     * the same room cannot dismiss a newer ring. Absent on old relays.
     */
    ringId?:        string;
  };
  MessengerSettings: undefined;
  /** Backup setup — first-time prompt to enable encrypted chat backup. */
  BackupSetup: undefined;
  /** Backup restore — entered after login when an existing backup is found. */
  BackupRestore: undefined;
  NewsHub: undefined;
  // News sub-screens accessible from the NewsHub tap targets — we host
  // them inside MessengerStack now that the root NewsTab is gone.
  IntelFeed: undefined;
  NewsFeed: undefined;
  NewsArticle: {articleId?: string; category?: string; title?: string};
  NewsPreferences: undefined;
};

// ─── Booking Stack ───────────────────────────────────────────────────────────

export type BookingStackParamList = {
  BookingHome: undefined;
  /** N-18/GAP-3 — the in-app notification centre (durable bell inbox). */
  ActivityCenter: undefined;
  ProDashboard: undefined;
  TripHistory: undefined;
  VBGHome: undefined;
  /** Optional context from an embedded map's expand affordance — the
      fullscreen map then shows the SAME analysed area/points instead of
      re-fetching around the live fix. */
  VBGMap: {
    centre?: {lat: number; lng: number};
    radiusKm?: number;
    points?: Array<{kind: 'police' | 'hospital' | 'embassy' | 'fire'; label: string; lat: number; lng: number; distanceKm: number}>;
  } | undefined;
  VBGNearby: undefined;
  VBGSRA: undefined;
  VBGOSINT: undefined;
  VBGGeoRisk: undefined;
  VBGEmergency: {countryName?: string; countryIso?: string} | undefined;
  IndividualProfile: undefined;
  CorporateProfile: undefined;
  ZoneMap: undefined;
  AddOns: undefined;
  BookingConfirmation: {
    bookingId: string;
    amountPaid?: number;
    currency?: string;
    paymentMethod?: 'card' | 'bravo_credits' | 'corporate';
    creditsAwarded?: number;
  };
  Credits: undefined;
  PaymentMethods: undefined;
  LiveTracking: {bookingId: string};
  TripSummary: {bookingId: string};
  // LM-U8 — full booking list behind Home's View All.
  BookingHistory: undefined;
  // F2 — the completion moment (rate + invoice + done).
  MissionComplete: {bookingId: string};
  // F1 — the numbered receipt / credit note.
  Invoice: {bookingId: string};
  RateAgency: {bookingId: string};
  Settings: undefined;
  SOSScreen: {bookingId: string};
  ProAssignedTeam: undefined;
  ProLiveMission: undefined;
  ProtectionHistory: undefined;
  OpsDashboard: undefined;
  OpsMissionDetail: {missionId: string};
  OpsRoomReview: {bookingId?: string} | undefined;
  ProActivityHistory: undefined;
  /** M1A — Profile → Messenger Plans (full messenger tier matrix + changes). */
  Pricing: undefined;
  /** M1A — messenger-tier paywall (Bravo Messenger Pro / Enterprise). */
  TierPaywall: {tier: 'pro' | 'enterprise'; returnTo?: keyof BookingStackParamList};
  CreditPaywall: undefined | {
    /** When the paywall is opened from OpsRoomReview after an existing
     *  booking failed the auto-debit, this carries the booking id so the
     *  success CTA can retry the charge against the right booking instead
     *  of creating a fresh draft. */
    bookingId?: string;
    source?: 'booking-flow' | 'opsroom' | 'wallet';
    amountDue?: number;
  };
  // ─── Bravo Secure Pro (request-and-approval custom plan) ───────────────────
  /** Tier-aware landing resolver: routes ACTIVE→ProDashboard, else→BookingHome
      (the Secure product root; the plan chooser is a card on BookingHome). */
  SecureLanding: undefined;
  /** Plan chooser: Secure Lite / Pro / Bravo Secure Lux (coming soon). */
  SecureServices: undefined;
  /** Bravo Secure Lux — coming-soon teaser / future-plan showcase. */
  SecureLux: undefined;
  /** Pro benefits overview — no pricing, CTA "Apply for Bravo Secure Pro". */
  SecureProIntro: undefined;
  /** Requirements form → POST /pro-applications. */
  SecureProApply: undefined;
  /** "My Pro Application" — live status + timeline while the Bravo Control
   *  System reviews; realtime + poll. */
  SecureProStatus: undefined;
  /** Custom proposal review (accept / request changes). */
  SecureProProposal: {applicationId: string};
  /** Pay & activate with Bravo Credits after acceptance. */
  SecureProPayment: {applicationId: string};
  /** Linked members — contact-picker add, relationship badges, limits/hold. */
  SecureProMembers: undefined;
  /** Premium period calendar — coverage months w/ mission dates highlighted. */
  SecureProCalendar: undefined;
  /** In-plan multi-date protection requests + their ops outcomes. */
  SecureProMissions: undefined;
  // Step 19 — client auto-dispatch flow (Uber-style): Searching → Accepted → (or No detail).
  FindingDetail: {bookingId: string};
  NoDetail: {bookingId: string};
  AgencyAccepted: {bookingId: string};
  ServiceType: undefined;
  BaselinePackage: undefined;
  // Wave 5b (PDF-2) — the consolidated Secure Transfer dashboard. It hosts the
  // folded-in Schedule section, so it receives the picked location back from
  // LocationPicker on the SAME merge-param contract as BookingDateTime.
  CustomizeAddOns: undefined | {
    pickedAddress?: string;
    pickedLat?: number;
    pickedLng?: number;
    pickedKind?: 'pickup' | 'dropoff';
    pickedAt?: number;
  };
  BookingDateTime: undefined | {
    pickedAddress?: string;
    pickedLat?: number;
    pickedLng?: number;
    pickedKind?: 'pickup' | 'dropoff';
    /** timestamp used as a "dirty" marker so the Schedule screen picks up
     *  fresh coordinates even when the object otherwise matches a previous
     *  selection (React Navigation shallow-compares params). */
    pickedAt?: number;
  };
  LocationPicker: {
    kind: 'pickup' | 'dropoff';
    countryCode: string;
    initial?: {latitude: number; longitude: number; address?: string};
    /** Route the picked location returns to (merge-navigate). Defaults to
     *  'BookingDateTime' for the Lite wizard; executive screens pass their own. */
    onPickRouteKey?: string;
  };
  // Wave 5d (PDF-2 A7) — the streamlined LITE 4-tab shell (Home · Book · Summary
  // · Messenger). A full-screen route hosting SecureTabNavigator; the tier
  // resolver seeds the LITE stack at it (Pro clients still land on ProDashboard).
  // Registered on BookingNavigator so every deeper booking route stays reachable
  // by bubbling up to this same stack — see SecureTabNavigator.tsx.
  SecureShell: undefined;
  // ─── Executive Protection (executive protection · fixed 3–24 h time blocks) ────────────
  /** Step 1 — duration block picker (3/6/9/12/15/18/21/24 h). */
  ExecDuration: undefined;
  /** Step 2 — book now / book later + start time (3 h lead when later). */
  ExecSchedule: undefined;
  /** Step 4 — task type + optional brief. Receives the service-location pick
   *  back from LocationPicker (same merge-param contract as BookingDateTime). */
  ExecTask: undefined | {
    pickedAddress?: string;
    pickedLat?: number;
    pickedLng?: number;
    pickedKind?: 'pickup' | 'dropoff';
    pickedAt?: number;
  };
  /** Step 5 — optional secure-transfer legs; receives transfer pickup/dropoff
   *  picks back from LocationPicker. */
  ExecTransport: undefined | {
    pickedAddress?: string;
    pickedLat?: number;
    pickedLng?: number;
    pickedKind?: 'pickup' | 'dropoff';
    pickedAt?: number;
  };
  /** Step 6 — team & add-ons (CPOs / vehicles / driver-only / add-ons). */
  ExecTeam: undefined;
  // Wave 5c (PDF-2) — the consolidated Executive Protection dashboard. It hosts the
  // folded-in Task + Transport sections, so it receives the picked location back
  // from LocationPicker on the SAME merge-param contract as ExecTask / ExecTransport.
  ExecReview: undefined | {
    pickedAddress?: string;
    pickedLat?: number;
    pickedLng?: number;
    pickedKind?: 'pickup' | 'dropoff';
    pickedAt?: number;
  };
};

// ─── Secure shell tabs (Wave 5d — the LITE 4-tab nav) ─────────────────────────
// Home · Book · Summary · Messenger. Each tab is a LEAF landing surface; drilling
// deeper (a service dashboard, a live mission) bubbles up to BookingNavigator,
// which still owns all ~55 booking routes — so no route is duplicated and every
// existing navigate(...) keeps resolving. Messenger is an EXIT (its press is
// intercepted and hops to the messenger stack), mirroring the Departmental shell.
export type SecureShellTabParamList = {
  Home: undefined;
  Book: undefined;
  Summary: undefined;
  Messenger: undefined;
};

// ─── News Stack ──────────────────────────────────────────────────────────────

export type NewsStackParamList = {
  NewsHub: undefined;
  NewsFeed: undefined;
  NewsArticle: {articleId?: string; category?: string; title?: string};
  IntelFeed: undefined;
  NewsPreferences: undefined;
};

// ─── Agent Stack ─────────────────────────────────────────────────────────────

export type AgentStackParamList = {
  AgentDashboard: undefined;
  /** N-18/GAP-3 — the in-app notification centre (durable bell inbox). */
  ActivityCenter: undefined;
  AgentProfile: undefined;
  AgentRegistration: undefined;
  AgentTypeSelect: undefined;
  AgentRegistrationWizard: undefined;
  /** Issue 34 — invitation-code entry for an officer joining a provider. */
  AgentInviteCode: undefined;
  AgentCoverage: undefined;
  AgentAvailability: undefined;
  AgentDocsUpload: undefined;
  AgentAdminApproval: undefined;
  AgentDeploymentRequirements: {missionId: string};
  MissionLeadConsole: {missionId: string};
  AgentLiveTracker: {missionId: string; mode?: 'agent' | 'cpo' | 'monitor'};
  AgentHome: undefined;
  AgentKYC: undefined;
  AgentVerified: undefined;
  AgentRejected: undefined;
  JobMarketplace: undefined;
  JobDetail: {jobId: string};
  Earnings: undefined;
  // Wallet top-up (audit F-04) — purchase reachable for provider roles too.
  Credits: {tab?: 'balance' | 'topup' | 'history'} | undefined;
  PaymentMethods: undefined;
  MissionSummary: {bookingId: string};
  // Service-provider org — managed-CPO roster + create + missions board (Step 13)
  OrgRoster: undefined;
  OrgMissions: undefined;
  // JOB_PORTAL_MARKETPLACE_SPEC Fix B — the standalone open-jobs marketplace.
  JobPortal: undefined;
  // F6 — the agency earnings roll-up.
  OrgEarnings: undefined;
  OrgCompliance: undefined;
  // Provider operating-region setting (agents.region_code) — GPS default-assign + change guard.
  OrgRegion: undefined;
  OrgCreateCpo: undefined;
  // MISSION-HISTORY (#3) — a roster CPO's completed/aborted-mission call-log.
  OrgCpoMissions: {memberUserId: string; displayName?: string | null};
  // Full officer profile — identity, compliance, stats and mission history.
  OrgCpoProfile: {memberUserId: string; displayName?: string | null};
  // Org chart: owner → managers → cpos/employees.
  OrgHierarchy: undefined;
  // Owner-exclusive — grant/revoke each manager's dashboard modules (D5).
  ManagerPermissions: undefined;
  // SP-MISSION-DETAIL (#2nd) — full mission detail page (escrow + crew + step flow).
  OrgMissionDetail: {job: OrgMissionDto};
  // Step 20 — full-screen incoming-offer interrupt (countdown bound to expires_at).
  // Issue 40 — offerId is OPTIONAL: a dispatch-offer push tap has no offer id
  // (the server wake carries only a bookingId), so the screen resolves the live
  // offer from dispatchApi.getCurrentOffer(). Typing it as required let the push
  // producer and the screen disagree without the compiler noticing.
  IncomingOffer: {offerId?: string; bookingId?: string} | undefined;
  Attendance: undefined;
  // Dept Chat v2 — member attendance + incident screens (flag-gated entries).
  VerifyAttendance: {shiftId?: string; siteLabel?: string | null; mode?: 'checkin' | 'checkout'};
  AttendanceResult: {
    status?: AttendanceStatusDto | null;
    reviewReason?: ReviewReasonDto | null;
    clockInAt?: string | null;
    siteLabel?: string | null;
    mode?: 'checkin' | 'checkout';
  };
  MyAttendance: undefined;
  ReportIncidentCategory: undefined;
  /** Item H — `draft` carries a resumed draft's content (URIs only). */
  ReportIncidentDetails: {
    category: IncidentCategoryDto; severity: IncidentSeverityDto;
    draft?: {description: string; media: Array<{uri: string; mime: string; kind: 'image' | 'video'}>; manualLabel?: string};
  };
  IncidentSubmitted: {ref: string | null; status: IncidentStatusDto; severity: IncidentSeverityDto};
  // Manager surfaces (Step 15)
  AdminAttendance: undefined;
  IncidentQueue: undefined;
  IncidentDetail: {incidentId: string; ref?: string | null};
  // Step 19 — the dedicated 5-tab "Departmental" module (pushed full-screen).
  Departmental: NavigatorScreenParams<DepartmentalTabParamList> | undefined;
  // F-WSHUB deliberately NOT declared here: no navigator on this shell
  // registers it, and a phantom declaration lets a bare navigate compile
  // and silently no-op. The hub lives on MessengerStackParamList only.
  AgentVerificationStatus: undefined;
  // Cross-module messenger screens (full stack available from agent portal)
  MessengerHome: {tab?: MessengerHomeTab} | undefined;
  Chat: {conversationId: string; name: string; isGroup: boolean; draft?: string; focusMessageId?: string};
  NewChat: {addToGroupId: string; groupName: string} | undefined;
  ChatInfo: {conversationId: string};
  VaultLock: VaultGateParams;
  VaultScreen: undefined;
  FileVaultPurchase: undefined;
  VaultForgot: VaultGateParams;
  VaultOTPVerify: VaultOtpVerifyParams;
  VaultNewPin: VaultNewPinParams;
  Groups: undefined;
  Files: undefined;
  // The messenger Settings pane. Registered here (not just declared) because
  // MessengerHomeScreen's gear tap bare-navigates to it from this shell too —
  // it was a silent no-op — and because the vault's biometric OFF switch lives
  // on it and the consent prompt that promises it fires in every shell.
  MessengerSettings: undefined;
  // W1b — MessengerSettings' own outbound tap (the Chat Backup row). Mounting
  // the pane here without this makes that row the same dead tap the line above
  // fixes.
  BackupSetup: undefined;
  // VoiceCall is the legacy alias used in older agent flows. The
  // call screens are all also registered here so the agent UI can
  // launch into a 1:1 / group / ringing flow. Full param shapes live
  // on the MessengerStackParamList side; agent-side typing stays
  // loose because the same components are reached via different
  // navigation paths.
  VoiceCall: {conversationId: string; name: string};
  CallScreen: MessengerStackParamList['CallScreen'];
  GroupCallScreen: MessengerStackParamList['GroupCallScreen'];
  IncomingGroupCallScreen: MessengerStackParamList['IncomingGroupCallScreen'];
  IntelFeed: undefined;
  // N2 — the shared MessengerHome footer's Call + News taps target these. The
  // agency shell mounts MessengerHomeScreen directly (not MessengerNavigator),
  // so without them those two taps silently no-op here. Their own outbound
  // targets (Links / News sub-screens) ride along so the tabs are not
  // half-working. The CPO shell is unaffected — it mounts MessengerNavigator.
  CallsLog: undefined;
  Links: undefined;
  /** Client 2026-08-22 — the Calls header Emergency door, registered in this
   *  shell too (an unregistered declaration is a silent no-op — N2). */
  EmergencyServices: {countryIso?: string; countryName?: string} | undefined;
  /** F-WSHUB — the workspace list. Registered in this shell (2026-08-22) so the
   *  Messenger Channels tab lands on the org picker here too. */
  WorkspaceHub: undefined;
  NewsHub: undefined;
  NewsFeed: undefined;
  NewsArticle: {articleId?: string; category?: string; title?: string};
  NewsPreferences: undefined;
};

// ─── CPO Stack (managed guard — §35A) ────────────────────────────────────────
// The 4-tab guard shell. Capability-hidden by construction: no booking wizard,
// client wallet, job-offer accept, roster/assign-crew, or org-money screens are
// registered here (PR5). Tab contents are fleshed out in the CPO-UI step; this
// step wires the shell + activation gate + access-ended.
export type CpoTabParamList = {
  CpoDuty: undefined;
  CpoMission: undefined;
  CpoComms: NavigatorScreenParams<MessengerStackParamList> | undefined;
  CpoDept: undefined;
  CpoMe: undefined;
};

// ─── Departmental module (Dept Chat v2 — Step 19) ─────────────────────────────
// The dedicated 5-tab "Departmental" shell (PDF p.2 Product Map), opened by BOTH
// parties (managed CPO + service-provider company/manager) as a full-screen push.
// Each tab is its own native-stack reusing the Step 12–18 feature screens; param
// shapes are kept in sync with the canonical Agent/Messenger lists via indexed
// access so the reused screens type-check unchanged.

export type DeptChannelsStackParamList = {
  DepartmentChannels: MessengerStackParamList['DepartmentChannels'];
  DepartmentChat: MessengerStackParamList['DepartmentChat'];
  ManageChannels: MessengerStackParamList['ManageChannels'];
  // F11 — the directory's "add your team" CTA target. Registered only in
  // MessengerNavigator before, so the tap was silently dropped in the Agent and
  // CPO shells (both reach the directory through THIS stack).
  Employees: MessengerStackParamList['Employees'];
  ChannelEditor: MessengerStackParamList['ChannelEditor'];
  ChannelMembers: MessengerStackParamList['ChannelMembers'];
  // Scope v2 Phase 3 (R6-2/R6-3). These three were registered ONLY in
  // MessengerNavigator, which the Agent and CPO shells do not mount — and every
  // approver persona (agency owner AND promoted org manager, resolveRoute.ts:60)
  // lands in the Agent shell. So no admin could open the approvals inbox and no
  // applicant in those shells could open the join screens: the loop terminated
  // at "pending" forever. Registering them on the Departmental shell's Channels
  // stack puts them in every tree that hosts the feature.
  Approvals: MessengerStackParamList['Approvals'];
  JoinWorkspace: MessengerStackParamList['JoinWorkspace'];
  EnterpriseSetup: undefined;
  CreateWorkspace: undefined;
  ApprovalStatus: MessengerStackParamList['ApprovalStatus'];
  InviteMember: MessengerStackParamList['InviteMember'];
};

export type DeptAttendStackParamList = {
  Attendance: AgentStackParamList['Attendance'];
  VerifyAttendance: AgentStackParamList['VerifyAttendance'];
  AttendanceResult: AgentStackParamList['AttendanceResult'];
  MyAttendance: AgentStackParamList['MyAttendance'];
  AdminAttendance: AgentStackParamList['AdminAttendance'];
  // Step 21 — manager shift management (create shift + geofence + assign CPOs).
  ShiftManagement: undefined;
  /** Q6 — `dates` (local YYYY-MM-DD, from the roster calendar multi-select)
   *  switches create mode to one-shift-per-date; ignored when editing. */
  ShiftEditor: {shift?: ShiftDto; dates?: string[]} | undefined;
  // Step 22 (G5) — manager sets a non-check-in day status (leave/sick/off-duty/absent).
  DayStatus: undefined;
  /** A7.2 (B2) — the month planning calendar. `month` = 'YYYY-MM'. */
  MonthlyRoster: {month?: string} | undefined;
  /** A7.4 (C1) — corrections. With a session → the editor; without → the list.
   *  The full row rides the param (the ShiftEditor precedent) because pending/
   *  org session reads are already effective-folded server-side (C2), so the
   *  editor's "Recorded value" needs no extra fetch. */
  Corrections: {session?: ShiftSessionDto} | undefined;
};

export type DeptIncidentStackParamList = {
  ReportIncidentCategory: AgentStackParamList['ReportIncidentCategory'];
  ReportIncidentDetails: AgentStackParamList['ReportIncidentDetails'];
  IncidentSubmitted: AgentStackParamList['IncidentSubmitted'];
  IncidentQueue: AgentStackParamList['IncidentQueue'];
  IncidentDetail: AgentStackParamList['IncidentDetail'];
  // Step 23 — member's own submitted incidents (read-only; never internal notes).
  MyIncidents: undefined;
  MyIncidentDetail: {report: IncidentReportDto};
};

// Vault tab reuses the messenger vault flow verbatim. The root is named
// 'MessengerHome' (FilesScreen) so VaultLockScreen's hardware-back reset target
// resolves to the vault tab root instead of erroring — see DepartmentalNavigator.
export type DeptVaultStackParamList = {
  MessengerHome: undefined;
  VaultLock: VaultGateParams;
  VaultScreen: undefined;
  VaultNewPin: VaultNewPinParams;
  VaultForgot: VaultGateParams;
  VaultOTPVerify: VaultOtpVerifyParams;
  FileVaultPurchase: undefined;
  // The vault's biometric OFF switch. This tab mounts VaultLock/VaultNewPin,
  // so the consent prompt fires here — the off-ramp it promises has to exist
  // here too, or the promise is a lie in the CPO/workspace shell.
  MessengerSettings: undefined;
  // W1b — transitive: the Settings pane's Chat Backup row navigates here.
  BackupSetup: undefined;
};

export type DepartmentalTabParamList = {
  Home: undefined;
  Channels: NavigatorScreenParams<DeptChannelsStackParamList> | undefined;
  Attend: NavigatorScreenParams<DeptAttendStackParamList> | undefined;
  Incident: NavigatorScreenParams<DeptIncidentStackParamList> | undefined;
  Vault: NavigatorScreenParams<DeptVaultStackParamList> | undefined;
  // Shown in the workspace bottom bar but never navigated to — its tab press is
  // intercepted and exits to the messenger stack. It needs a param entry so the
  // Tab.Screen typechecks.
  Messenger: undefined;
  /**
   * UI corrections 2026-08-15 item 07 — the fifth bar destination, mounted
   * IN-SHELL (unlike Messenger, which exits). `NewsHub` is registered only
   * inside MessengerNavigator, so an exit would drop agency and CPO users on the
   * chat list; mounting keeps all three host shells identical.
   */
  News: NavigatorScreenParams<NewsStackParamList> | undefined;
};

// CPO root — wraps the 4-tab guard shell so the Departmental module can be pushed
// full-screen over it (its own footer, no nested-tab double footer). The four
// guard tabs stay in CpoTabParamList — capability lockdown (§35A §D) unchanged.
export type CpoRootStackParamList = {
  CpoTabs: NavigatorScreenParams<CpoTabParamList> | undefined;
  /** Pro mission-code gate + the dedicated Pro mission view. */
  CpoProMission: undefined;
  Departmental: NavigatorScreenParams<DepartmentalTabParamList> | undefined;
  // F-WSHUB deliberately NOT declared here — see AgentStackParamList note.
  // Step 31 — the map-first live tracker (the design), pushed full-screen over
  // the guard tabs. Reuses AgentLiveTrackerScreen in cpo mode (dual markers +
  // Google-Maps turn-by-turn). Reached from the Mission tab while DISPATCHED/PICKUP/LIVE.
  CpoLiveTracker: {missionId: string; mode?: 'cpo'};
  // Same reason as MessengerStackParamList.OrgCpoProfile — a CPO who is a
  // channel admin can tap a message avatar too.
  OrgCpoProfile: {memberUserId: string; displayName?: string | null};
  // Protection sessions (spec §6) — CPO overview + one live session (map + trail).
  CpoProtection: {sessionId?: string} | undefined;
  CpoProtectionSession: {sessionId: string};
  CpoProtectionHistory: undefined;
};

// ─── Root Stack (wraps all) ──────────────────────────────────────────────────

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
  AgentStack: undefined;
  // §35A §F — terminal CPO access-ended screen, shown above the auth form once a
  // revoked guard has been torn down (survives signOut via the accessEnded flag).
  AccessEnded: undefined;
};

// ─── Screen prop types ────────────────────────────────────────────────────────

export type AuthScreenProps<T extends keyof AuthStackParamList> = NativeStackScreenProps<
  AuthStackParamList,
  T
>;

export type MessengerScreenProps<T extends keyof MessengerStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<MessengerStackParamList, T>,
  BottomTabScreenProps<MainTabParamList>
>;

export type BookingScreenProps<T extends keyof BookingStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<BookingStackParamList, T>,
  BottomTabScreenProps<MainTabParamList>
>;
