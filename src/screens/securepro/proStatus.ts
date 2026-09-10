import type {ProApplicationStatus} from '@services/api';

// Single client-side source of truth for Bravo Secure Pro application status
// presentation (status screen hero, home row pill, notifications).
// Colors are the obsidian palette literals used across securepro screens.

export interface ProStatusMeta {
  label: string;
  color: string;
  icon: string;
  copy: string;
}

export const PRO_STATUS_META: Record<ProApplicationStatus, ProStatusMeta> = {
  PENDING_PROPOSAL: {
    label: 'Pending Proposal', color: '#F5C76B', icon: 'clock-outline',
    copy: 'The Bravo Control System is reviewing your requirements and preparing a custom proposal. You can keep using Bravo Secure Lite in the meantime.',
  },
  PROPOSAL_CREATED: {
    label: 'Proposal Ready', color: '#A9C5FF', icon: 'file-document-outline',
    copy: 'Your custom proposal is ready — review the plan, team and the total Bravo Credits for your coverage period.',
  },
  REVISION_REQUESTED: {
    label: 'Revision Requested', color: '#F5C76B', icon: 'message-reply-text-outline',
    copy: 'You asked for changes. The Bravo Control System is revising your proposal.',
  },
  ACCEPTED: {
    label: 'Accepted', color: '#4ADE80', icon: 'check-decagram-outline',
    copy: 'Proposal accepted — activate your plan with Bravo Credits to go live.',
  },
  ACTIVE: {
    label: 'Active', color: '#4ADE80', icon: 'shield-star',
    copy: 'Your Bravo Secure Pro plan is live. Your dedicated team and Pro dashboard are ready.',
  },
  REJECTED: {
    label: 'Rejected', color: '#FF5D5D', icon: 'close-octagon-outline',
    copy: 'This application was not approved. You can contact support or submit a new request.',
  },
  EXPIRED: {
    label: 'Expired', color: '#F5C76B', icon: 'calendar-remove-outline',
    copy: 'Your coverage period has ended. Renew with your previous details in one tap, or customise a new plan.',
  },
  CANCELLED: {
    label: 'Cancelled', color: '#FF5D5D', icon: 'close-circle-outline',
    copy: 'This application was cancelled. Nothing was charged — you can submit a new request any time.',
  },
};
