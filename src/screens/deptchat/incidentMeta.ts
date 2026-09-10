import type {ComponentProps} from 'react';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {IncidentCategoryDto, IncidentSeverityDto, IncidentStatusDto} from '@services/api';
import {OB} from './_obsidian';

type IconName = ComponentProps<typeof Icon>['name'];

// The 15 categories (PDF p.11) in display order, with a label + icon. The
// keys MUST match the backend allow-list (incident.constants.ts) exactly.
export const INCIDENT_CATEGORY_META: Record<IncidentCategoryDto, {label: string; icon: IconName}> = {
  security_concern:       {label: 'Security Concern',      icon: 'shield-alert-outline'},
  safety_issue:           {label: 'Safety Issue',          icon: 'alert-octagon-outline'},
  medical_incident:       {label: 'Medical Incident',      icon: 'medical-bag'},
  suspicious_activity:    {label: 'Suspicious Activity',   icon: 'eye-outline'},
  access_control:         {label: 'Access Control',        icon: 'door-closed-lock'},
  property_damage:        {label: 'Property Damage',       icon: 'home-alert-outline'},
  vehicle_issue:          {label: 'Vehicle Issue',         icon: 'car-emergency'},
  staff_misconduct:       {label: 'Staff Misconduct',      icon: 'account-alert-outline'},
  visitor_contractor:     {label: 'Visitor / Contractor',  icon: 'account-question-outline'},
  equipment_failure:      {label: 'Equipment Failure',     icon: 'cog-off-outline'},
  operational_disruption: {label: 'Operational Disruption', icon: 'flash-alert-outline'},
  harassment_workplace:   {label: 'Workplace Harassment',  icon: 'account-cancel-outline'},
  lost_property:          {label: 'Lost Property',         icon: 'briefcase-search-outline'},
  fire_hazard:            {label: 'Fire Hazard',           icon: 'fire-alert'},
  other:                  {label: 'Other',                 icon: 'dots-horizontal-circle-outline'},
};

export const INCIDENT_CATEGORIES = Object.keys(INCIDENT_CATEGORY_META) as IncidentCategoryDto[];

export const INCIDENT_SEVERITIES: {key: IncidentSeverityDto; label: string; color: string}[] = [
  {key: 'low',      label: 'Low',      color: OB.signal},
  {key: 'medium',   label: 'Medium',   color: OB.accentSoft},
  {key: 'high',     label: 'High',     color: OB.amber},
  {key: 'critical', label: 'Critical', color: OB.alert},
];

export function severityColor(sev?: IncidentSeverityDto | null): string {
  return INCIDENT_SEVERITIES.find(s => s.key === sev)?.color ?? OB.accentSoft;
}

// Status label + colour for the manager queue/detail (Step 9/15).
export const INCIDENT_STATUS_META: Record<IncidentStatusDto, {label: string; color: string}> = {
  submitted:       {label: 'Submitted',       color: OB.accentSoft},
  received:        {label: 'Received',         color: OB.accentSoft},
  under_review:    {label: 'Under Review',     color: OB.amber},
  action_assigned: {label: 'Action Assigned',  color: OB.amber},
  resolved:        {label: 'Resolved',         color: OB.signal},
  closed:          {label: 'Closed',           color: OB.textMute},
};

// Allowed next status(es) shown as buttons in the detail screen. Mirrors
// incident-fsm.ts; the closed→under_review reopen is company-admin only and the
// server enforces it (the button just surfaces the option).
export const INCIDENT_NEXT: Record<IncidentStatusDto, IncidentStatusDto[]> = {
  submitted:       ['received'],
  received:        ['under_review'],
  under_review:    ['action_assigned'],
  action_assigned: ['resolved'],
  resolved:        ['closed', 'under_review'],
  closed:          ['under_review'],
};
