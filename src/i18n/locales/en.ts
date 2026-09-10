/** English catalog (BUILD_RUNBOOK Step 25) — the fallback language + key source of truth. */
const en: Record<string, string> = {
  // Settings
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.currency': 'Currency',
  'settings.notifications': 'Notifications',
  'settings.notifications.safety': 'Safety alerts',
  'settings.notifications.safety.locked': 'Always on',
  'settings.notifications.trip': 'Trip updates',
  'settings.notifications.marketing': 'Offers & news',
  'settings.location': 'Location sharing',
  'settings.location.while_on_duty': 'While on duty',
  'settings.location.during_mission': 'During a mission only',
  'settings.location.never': 'Never',
  'settings.appLock': 'App lock',
  'settings.appLock.desc': 'Require Face ID / passcode to open the app',
  'settings.restartPrompt': 'Restart required to fully apply the new layout direction.',
  'settings.saved': 'Preferences saved',
  // Common
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.done': 'Done',
  'common.retry': 'Try again',
  // Dispatch path (a representative subset; extend incrementally)
  'dispatch.finding': 'Finding an agency near you…',
  'dispatch.noProvider': 'No agency available right now',
  'dispatch.rate.title': 'Rate the agency',
  'dispatch.consent': 'I consent to sharing my live location with the assigned agency.',
};
export default en;
