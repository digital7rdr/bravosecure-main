// Closed sets shared by the DTO validation, the incident_reports CHECK
// constraints (20260629000001), and the status FSM (Step 9) — one source of
// truth so SQL and TS can't drift.

// The 15 incident categories (PDF p.11). Validated in the DTO allow-list.
export const INCIDENT_CATEGORIES = [
  'security_concern', 'safety_issue', 'medical_incident', 'suspicious_activity',
  'access_control', 'property_damage', 'vehicle_issue', 'staff_misconduct',
  'visitor_contractor', 'equipment_failure', 'operational_disruption',
  'harassment_workplace', 'lost_property', 'fire_hazard', 'other',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

// Status lifecycle (PDF p.15). The FSM transitions live in Step 9; the set +
// the CHECK constraint live here / in the migration.
export const INCIDENT_STATUSES = [
  'submitted', 'received', 'under_review', 'action_assigned', 'resolved', 'closed',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
