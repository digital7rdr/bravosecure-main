import type {ProApplicationRow, ProApplicationStatus} from '@/lib/api';

// Presentation helpers shared by the Pro Applications list + detail pages.

export function proStatusTone(status: ProApplicationStatus): string {
  switch (status) {
    case 'PENDING_PROPOSAL':
    case 'REVISION_REQUESTED': return 'warn';
    case 'PROPOSAL_CREATED':   return 'info';
    case 'ACCEPTED':           return 'ok';
    case 'ACTIVE':             return 'live';
    case 'EXPIRED':            return 'warn';
    case 'REJECTED':           return 'err';
    case 'CANCELLED':          return 'err';
  }
}

export function intendedUseLabel(row: Pick<ProApplicationRow, 'intended_use' | 'intended_use_note'>): string {
  if (row.intended_use === 'custom' && row.intended_use_note) return row.intended_use_note;
  return row.intended_use.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function durationLabel(row: Pick<ProApplicationRow, 'duration_months' | 'duration_note'>): string {
  if (row.duration_months) return `${row.duration_months} mo`;
  return row.duration_note ?? 'Custom';
}

export const PRO_SERVICE_CATALOG = [
  'secure_transfers', 'medical_support', 'advance_assessment',
  'secure_communications', 'journey_monitoring', 'event_support',
  'residential_support',
] as const;

export function serviceLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
