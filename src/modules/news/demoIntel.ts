/**
 * Demo intel fallback.
 *
 * The Guardian "test" API key is aggressively rate-limited, so on a
 * fresh install we can easily hit a 429 before the first real fetch
 * succeeds. Rather than show an empty Wire + empty Map, we fall back
 * to this curated set of synthetic headlines so the UI always has
 * something representative to render. Swap in a real
 * EXPO_PUBLIC_GUARDIAN_API_KEY to get live content.
 */

import type {GuardianResult} from './guardianClient';

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const DEMO_INTEL: GuardianResult[] = [
  {
    id:                 'demo/red-sea-corridor',
    webTitle:           'Ballistic alert — Red Sea corridor ACTIVE, shipping diverted',
    webUrl:             'https://www.theguardian.com/world',
    sectionId:          'world',
    sectionName:        'World news',
    webPublicationDate: minsAgo(4),
    fields: {trailText: 'Multiple carriers reroute via Cape of Good Hope as naval alert escalates in the Red Sea corridor.'},
  },
  {
    id:                 'demo/riyadh-protest',
    webTitle:           'Riyadh protest zone — 400+ crowd, police deployed downtown',
    webUrl:             'https://www.theguardian.com/world',
    sectionId:          'world',
    sectionName:        'World news',
    webPublicationDate: minsAgo(12),
    fields: {trailText: 'Civic demonstration swelled to more than 400 people in central Riyadh, Saudi Arabia.'},
  },
  {
    id:                 'demo/uae-difc-q1',
    webTitle:           'UAE DIFC records highest Q1 volume in financial services',
    webUrl:             'https://www.theguardian.com/business',
    sectionId:          'business',
    sectionName:        'Business',
    webPublicationDate: minsAgo(23),
    fields: {trailText: 'Dubai International Financial Centre posts Q1 activity that eclipses 2025 highs.'},
  },
  {
    id:                 'demo/aramco-q1',
    webTitle:           'Saudi Aramco Q1 earnings beat forecast on energy demand',
    webUrl:             'https://www.theguardian.com/business',
    sectionId:          'business',
    sectionName:        'Business',
    webPublicationDate: minsAgo(38),
    fields: {trailText: 'Aramco beats consensus on stronger-than-expected energy demand across Asia.'},
  },
  {
    id:                 'demo/sudan-chad',
    webTitle:           'Sudan-Chad border armed incursion reported overnight',
    webUrl:             'https://www.theguardian.com/world',
    sectionId:          'world',
    sectionName:        'World news',
    webPublicationDate: minsAgo(51),
    fields: {trailText: 'Armed group crossed the Sudan-Chad border overnight, eyewitnesses tell local radio.'},
  },
  {
    id:                 'demo/uae-cyber',
    webTitle:           'UAE cyber grid: coordinated intrusion attempts flagged',
    webUrl:             'https://www.theguardian.com/technology',
    sectionId:          'technology',
    sectionName:        'Technology',
    webPublicationDate: minsAgo(66),
    fields: {trailText: 'National cyber authority confirms a coordinated attempt targeting critical UAE infrastructure.'},
  },
  {
    id:                 'demo/moscow-tensions',
    webTitle:           'Moscow tensions rise as diplomatic channels stall',
    webUrl:             'https://www.theguardian.com/world',
    sectionId:          'politics',
    sectionName:        'Politics',
    webPublicationDate: minsAgo(81),
    fields: {trailText: 'Western envoys report breakdown in back-channel talks with Moscow counterparts.'},
  },
  {
    id:                 'demo/london-finance',
    webTitle:           'London finance: bond yields spike as inflation print surprises',
    webUrl:             'https://www.theguardian.com/business',
    sectionId:          'business',
    sectionName:        'Business',
    webPublicationDate: minsAgo(104),
    fields: {trailText: 'UK 10-year gilts spike after a hotter-than-expected CPI print from ONS.'},
  },
  {
    id:                 'demo/singapore-maritime',
    webTitle:           'Singapore maritime lanes: congestion up 18% week-on-week',
    webUrl:             'https://www.theguardian.com/business',
    sectionId:          'business',
    sectionName:        'Business',
    webPublicationDate: minsAgo(130),
    fields: {trailText: 'Container throughput through the Strait of Malacca hits a quarterly high.'},
  },
  {
    id:                 'demo/arabian-sea',
    webTitle:           'Arabian Sea: joint naval exercise enters second phase',
    webUrl:             'https://www.theguardian.com/world',
    sectionId:          'world',
    sectionName:        'World news',
    webPublicationDate: minsAgo(155),
    fields: {trailText: 'Multinational naval exercise moves into its live-fire phase off the Omani coast.'},
  },
];
