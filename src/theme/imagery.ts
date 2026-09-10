/**
 * Bravo brand imagery registry — the ONE place a screen resolves a photo.
 *
 * Why a registry and not a `require()` at the call site:
 *   * Metro only understands STATIC `require` literals, so the paths have to be
 *     spelled out somewhere regardless. Centralising them means a screen names
 *     an INTENT (`Imagery.proLiveMap`) instead of a filename, and re-shooting an
 *     asset is a one-line change here rather than a hunt across 199 screens.
 *   * The keys are pinned by `imageryRegistry.test.ts` against the files the
 *     pipeline emits, so a renamed/dropped asset fails a test instead of
 *     rendering an invisible broken image on a client's phone.
 *
 * The files are generated — do NOT hand-edit `src/assets/imagery/*.jpg`.
 * Source drop: `Proton Drive Download - 2026-08-25/`
 * Pipeline:    `python scripts/optimize-imagery.py`
 *
 * Format is JPEG on purpose: React Native's default iOS image loader does not
 * decode WebP, so a bundled `.webp` renders blank on iPhone while looking fine
 * on Android. Do not "optimise" these to WebP without adding an iOS decoder.
 */
import type {ImageSourcePropType} from 'react-native';

export const Imagery = {
  // ─── Booking / Secure home ───────────────────────────────────────────
  get heroBookProtection(): ImageSourcePropType { return require('../assets/imagery/heroBookProtection.jpg'); },
  get heroMissionActive(): ImageSourcePropType { return require('../assets/imagery/heroMissionActive.jpg'); },
  get trustEncryption(): ImageSourcePropType { return require('../assets/imagery/trustEncryption.jpg'); },
  get trustVettedCpos(): ImageSourcePropType { return require('../assets/imagery/trustVettedCpos.jpg'); },
  get trustLiveTracking(): ImageSourcePropType { return require('../assets/imagery/trustLiveTracking.jpg'); },
  get trustSecureComms(): ImageSourcePropType { return require('../assets/imagery/trustSecureComms.jpg'); },

  // ─── Secure Pro modules ──────────────────────────────────────────────
  get proItinerary(): ImageSourcePropType { return require('../assets/imagery/proItinerary.jpg'); },
  get proDesignatedTeam(): ImageSourcePropType { return require('../assets/imagery/proDesignatedTeam.jpg'); },
  get proLiveMap(): ImageSourcePropType { return require('../assets/imagery/proLiveMap.jpg'); },
  get proBookingRequests(): ImageSourcePropType { return require('../assets/imagery/proBookingRequests.jpg'); },
  get proRiskIntel(): ImageSourcePropType { return require('../assets/imagery/proRiskIntel.jpg'); },
  get proReports(): ImageSourcePropType { return require('../assets/imagery/proReports.jpg'); },

  // ─── Agent / Org dashboard modules ───────────────────────────────────
  // Founder drop 2026-08-31. These are ROW plates (see the `row` role in
  // scripts/optimize-imagery.py): the agent dashboard keeps its full-width
  // nav rows, so the art is composed onto a 4.8:1 obsidian canvas rather
  // than cropped to one — a card crop takes a thin band out of the middle.
  get agentMissions(): ImageSourcePropType { return require('../assets/imagery/agentMissions.jpg'); },
  get agentJobStandby(): ImageSourcePropType { return require('../assets/imagery/agentJobStandby.jpg'); },
  get agentJobPortal(): ImageSourcePropType { return require('../assets/imagery/agentJobPortal.jpg'); },
  get agentCompliance(): ImageSourcePropType { return require('../assets/imagery/agentCompliance.jpg'); },
  get agentRoster(): ImageSourcePropType { return require('../assets/imagery/agentRoster.jpg'); },
  get agentOrgChart(): ImageSourcePropType { return require('../assets/imagery/agentOrgChart.jpg'); },
  get agentDepartmental(): ImageSourcePropType { return require('../assets/imagery/agentDepartmental.jpg'); },
  get agentRegion(): ImageSourcePropType { return require('../assets/imagery/agentRegion.jpg'); },
  get agentEarnings(): ImageSourcePropType { return require('../assets/imagery/agentEarnings.jpg'); },
  get agentManagerPerms(): ImageSourcePropType { return require('../assets/imagery/agentManagerPerms.jpg'); },
  get agentIntelFeed(): ImageSourcePropType { return require('../assets/imagery/agentIntelFeed.jpg'); },

  // ─── Departmental / enterprise workspace ─────────────────────────────
  get deptSecureConnection(): ImageSourcePropType { return require('../assets/imagery/deptSecureConnection.jpg'); },
  get deptAttendance(): ImageSourcePropType { return require('../assets/imagery/deptAttendance.jpg'); },
  get deptIncident(): ImageSourcePropType { return require('../assets/imagery/deptIncident.jpg'); },
  get deptChannels(): ImageSourcePropType { return require('../assets/imagery/deptChannels.jpg'); },
  get deptApprovals(): ImageSourcePropType { return require('../assets/imagery/deptApprovals.jpg'); },
  get deptWorkspaces(): ImageSourcePropType { return require('../assets/imagery/deptWorkspaces.jpg'); },

  // ─── Virtual Bodyguard dashboard ─────────────────────────────────────
  get vbgEmergencyCall(): ImageSourcePropType { return require('../assets/imagery/vbgEmergencyCall.jpg'); },
  get vbgNextOfKin(): ImageSourcePropType { return require('../assets/imagery/vbgNextOfKin.jpg'); },
  get vbgRequestSupport(): ImageSourcePropType { return require('../assets/imagery/vbgRequestSupport.jpg'); },
  get vbgSecurityRisk(): ImageSourcePropType { return require('../assets/imagery/vbgSecurityRisk.jpg'); },
  get vbgNearby(): ImageSourcePropType { return require('../assets/imagery/vbgNearby.jpg'); },
  get vbgLiveLocation(): ImageSourcePropType { return require('../assets/imagery/vbgLiveLocation.jpg'); },
  get vbgGeoRisk(): ImageSourcePropType { return require('../assets/imagery/vbgGeoRisk.jpg'); },

  // ─── News / intel ────────────────────────────────────────────────────
  get newsRegionalFeed(): ImageSourcePropType { return require('../assets/imagery/newsRegionalFeed.jpg'); },

  get proLinkedMembers(): ImageSourcePropType { return require('../assets/imagery/proLinkedMembers.jpg'); },
  get proBilling(): ImageSourcePropType { return require('../assets/imagery/proBilling.jpg'); },

  get creditsHero(): ImageSourcePropType { return require('../assets/imagery/creditsHero.jpg'); },
  get cpoStandby(): ImageSourcePropType { return require('../assets/imagery/cpoStandby.jpg'); },
  get workspaceEmpty(): ImageSourcePropType { return require('../assets/imagery/workspaceEmpty.jpg'); },

  get orgFinance(): ImageSourcePropType { return require('../assets/imagery/orgFinance.jpg'); },

  get requestProtection(): ImageSourcePropType { return require('../assets/imagery/requestProtection.jpg'); },

  // ─── Plan / package / job heroes ─────────────────────────────────────
  get proHero(): ImageSourcePropType { return require('../assets/imagery/proHero.jpg'); },
  get packageHero(): ImageSourcePropType { return require('../assets/imagery/packageHero.jpg'); },
  get jobOfferHero(): ImageSourcePropType { return require('../assets/imagery/jobOfferHero.jpg'); },

  // ─── Services ────────────────────────────────────────────────────────
  get svcCloseProtection(): ImageSourcePropType { return require('../assets/imagery/svcCloseProtection.jpg'); },
  get svcExecTransport(): ImageSourcePropType { return require('../assets/imagery/svcExecTransport.jpg'); },
  get svcAviation(): ImageSourcePropType { return require('../assets/imagery/svcAviation.jpg'); },
  get svcFamily(): ImageSourcePropType { return require('../assets/imagery/svcFamily.jpg'); },
  get svcVehicleSupport(): ImageSourcePropType { return require('../assets/imagery/svcVehicleSupport.jpg'); },
  get svcConsultation(): ImageSourcePropType { return require('../assets/imagery/svcConsultation.jpg'); },

  get messengerExec(): ImageSourcePropType { return require('../assets/imagery/messengerExec.jpg'); },

  // ─── Virtual Bodyguard ───────────────────────────────────────────────
  get vbgHero(): ImageSourcePropType { return require('../assets/imagery/vbgHero.jpg'); },
  get vbgCompanion(): ImageSourcePropType { return require('../assets/imagery/vbgCompanion.jpg'); },
  get vbgRiskAwareness(): ImageSourcePropType { return require('../assets/imagery/vbgRiskAwareness.jpg'); },

  // ─── Messenger / comms ───────────────────────────────────────────────
  get messengerHero(): ImageSourcePropType { return require('../assets/imagery/messengerHero.jpg'); },
  get messengerVault(): ImageSourcePropType { return require('../assets/imagery/messengerVault.jpg'); },

  // ─── Ops / agency ────────────────────────────────────────────────────
  get opsCenter(): ImageSourcePropType { return require('../assets/imagery/opsCenter.jpg'); },
  get opsOperator(): ImageSourcePropType { return require('../assets/imagery/opsOperator.jpg'); },
  get opsDispatch(): ImageSourcePropType { return require('../assets/imagery/opsDispatch.jpg'); },
  get opsJourneyMonitoring(): ImageSourcePropType { return require('../assets/imagery/opsJourneyMonitoring.jpg'); },
  get opsBriefing(): ImageSourcePropType { return require('../assets/imagery/opsBriefing.jpg'); },
  get opsSupport(): ImageSourcePropType { return require('../assets/imagery/opsSupport.jpg'); },

  // ─── Auth / onboarding ───────────────────────────────────────────────
  get authWelcome(): ImageSourcePropType { return require('../assets/imagery/authWelcome.jpg'); },
  get authClientApp(): ImageSourcePropType { return require('../assets/imagery/authClientApp.jpg'); },

  // ─── People (CPO / client portraits) ─────────────────────────────────
  get cpo1(): ImageSourcePropType { return require('../assets/imagery/cpo1.jpg'); },
  get cpo2(): ImageSourcePropType { return require('../assets/imagery/cpo2.jpg'); },
  get cpo3(): ImageSourcePropType { return require('../assets/imagery/cpo3.jpg'); },
  get cpo8(): ImageSourcePropType { return require('../assets/imagery/cpo8.jpg'); },
  get cpo9(): ImageSourcePropType { return require('../assets/imagery/cpo9.jpg'); },
  get cpo10(): ImageSourcePropType { return require('../assets/imagery/cpo10.jpg'); },
  get client1(): ImageSourcePropType { return require('../assets/imagery/client1.jpg'); },
  get client3(): ImageSourcePropType { return require('../assets/imagery/client3.jpg'); },
  get client4(): ImageSourcePropType { return require('../assets/imagery/client4.jpg'); },
  get clientFam(): ImageSourcePropType { return require('../assets/imagery/clientFam.jpg'); },
  get clientKids(): ImageSourcePropType { return require('../assets/imagery/clientKids.jpg'); },
} as const;

export type ImageryKey = keyof typeof Imagery;

/** Rotating pool for "a CPO, any CPO" surfaces (roster placeholders, team cards). */
export const CPO_PORTRAITS: readonly ImageryKey[] = [
  'cpo1', 'cpo2', 'cpo3', 'cpo8', 'cpo9', 'cpo10',
] as const;

/**
 * Deterministic portrait for an id — the SAME officer id always resolves to the
 * same face, so a roster does not reshuffle on every render. Not security
 * relevant; it is a display placeholder only.
 */
export function portraitFor(id: string | null | undefined): ImageSourcePropType {
  if (!id) {return Imagery[CPO_PORTRAITS[0]];}
  let h = 0;
  // `>>> 0` keeps the rolling hash an unsigned 32-bit int; without it a long id
  // overflows negative and the modulo below indexes off the front of the array.
  // eslint-disable-next-line no-bitwise
  for (let i = 0; i < id.length; i++) {h = (h * 31 + id.charCodeAt(i)) >>> 0;}
  return Imagery[CPO_PORTRAITS[h % CPO_PORTRAITS.length]];
}
