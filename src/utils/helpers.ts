import {format, formatDistanceToNow, isToday, isYesterday, differenceInCalendarDays} from 'date-fns';

// ─── Date / Time ─────────────────────────────────────────────────────────────

export function formatChatTimestamp(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isToday(d)) {return format(d, 'HH:mm');}
  if (isYesterday(d)) {return 'Yesterday';}
  return format(d, 'dd/MM/yyyy');
}

/**
 * BS-TS1 — relative timestamp for conversation-list rows. The list
 * previously printed time-of-day only (`14:32`), so a week-old chat was
 * indistinguishable from one sent minutes ago. WhatsApp-style tiers:
 * today → time, yesterday → "Yesterday", within a week → weekday,
 * older → short date. `now` is injectable for deterministic tests.
 */
export function formatListTimestamp(date: string | Date, now: Date = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const dayDiff = differenceInCalendarDays(now, d);
  if (dayDiff <= 0) {return format(d, 'HH:mm');}
  if (dayDiff === 1) {return 'Yesterday';}
  if (dayDiff < 7) {return format(d, 'EEE');}   // Mon, Tue, …
  return format(d, 'dd/MM/yyyy');
}

export function formatRelativeTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatDistanceToNow(d, {addSuffix: true});
}

export function formatBookingDuration(hours: number): string {
  if (hours < 24) {return `${hours}h`;}
  const days = Math.floor(hours / 24);
  const remaining = hours % 24;
  return remaining > 0 ? `${days}d ${remaining}h` : `${days}d`;
}

// ─── Currency ────────────────────────────────────────────────────────────────

// Why: 1 fiat unit = 1 BC (Phase-1 peg) — the currency param is kept for signature
// compatibility but the unit is always Bravo Credits.
export function formatCurrency(
  amount: number,
  _currency: string = 'USD',
): string {
  return `${Math.round(amount).toLocaleString('en-US')} BC`;
}

// ─── Phone ───────────────────────────────────────────────────────────────────

export function formatPhone(phone: string): string {
  // Strip non-digits and format
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

// ─── Risk Score ──────────────────────────────────────────────────────────────

export function getRiskLabel(score: number): 'Low' | 'Medium' | 'High' | 'Critical' {
  if (score < 25) {return 'Low';}
  if (score < 50) {return 'Medium';}
  if (score < 75) {return 'High';}
  return 'Critical';
}

export function getRiskColor(score: number): string {
  if (score < 25) {return '#00C851';}
  if (score < 50) {return '#FFB800';}
  if (score < 75) {return '#FF6B00';}
  return '#FF1A1A';
}

// ─── File ────────────────────────────────────────────────────────────────────

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1048576) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function getFileIcon(mime: string): string {
  if (mime.startsWith('image/')) {return 'image';}
  if (mime.startsWith('video/')) {return 'video';}
  if (mime.startsWith('audio/')) {return 'audio';}
  if (mime.includes('pdf')) {return 'pdf';}
  if (mime.includes('word') || mime.includes('document')) {return 'doc';}
  if (mime.includes('sheet') || mime.includes('excel')) {return 'sheet';}
  return 'file';
}

// ─── Avatar ──────────────────────────────────────────────────────────────────

export function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map(n => n[0])
    .join('')
    .toUpperCase();
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPhone(phone: string): boolean {
  return /^\+?[\d\s\-()]{7,15}$/.test(phone);
}
