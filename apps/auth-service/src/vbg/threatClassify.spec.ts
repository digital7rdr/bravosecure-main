import {classifyThreat} from './threatClassify';
import {titleCountryRefs, isLocallyRelevant} from './countryNames';

describe('classifyThreat', () => {
  it('catches REAL local incidents across types', () => {
    const cases: Array<[string, 'critical' | 'caution']> = [
      ["Fire erupts in Islamabad's Jinnah Super Market", 'caution'],
      ['Kashmir faces shutdown as protests leave more than 20 dead', 'critical'],
      ['Three suspected militants killed in raid', 'critical'],
      ['Two Black Axe cultists remanded over attempted murder', 'critical'],
      ['Acid attack victim shifted to hospital', 'critical'],
      ['Mob attacks police following child murder', 'critical'],
      ['Armed robbery at jewellery shop', 'critical'],
      ['Road accident on motorway leaves several injured', 'caution'],
      ['Police raid drug den, several detained', 'caution'],
      ['Protesters block highway over power cuts', 'caution'],
    ];
    for (const [title, sev] of cases) {
      expect(classifyThreat(title).severity).toBe(sev);
    }
  });

  it('rejects non-incident NOISE as information', () => {
    const noise = [
      'Lebanon ceasefire agreed after US-Iran talks in Switzerland',
      'Benazir Bhutto And The Politics Of Hope',
      'The leopard princess of Islamabad',
      'In call with MBS, PM Shehbaz discusses trade',
      'Hoshiarpur women cricket team enter final with 95-run victory',
      'Pakistan stock market rally continues amid economic optimism',
      'New film breaks box office records this weekend',
    ];
    for (const title of noise) {
      expect(classifyThreat(title).severity).toBe('information');
    }
  });

  // Founder SRA relevance report 2026-08-01 — a health explainer was scoring
  // CRITICAL (theme 'fatal') and landing in Violent Crime.
  it('health/medical idiom does not read as a threat', () => {
    const health = [
      'How simple test for killer cholesterol can prevent fatal heart attack',
      'Doctors warn fatal heart disease risk rising with obesity',
      'New cancer therapy shows dramatic results in trial',
    ];
    for (const title of health) {
      expect(classifyThreat(title).severity).toBe('information');
    }
  });

  it('a REAL incident at a medical venue still classifies (only ambiguous words are suppressed)', () => {
    expect(classifyThreat('Gunman opens fire at hospital, three killed').severity).toBe('critical');
  });
});

describe('SRA locality screen (founder relevance rule 2026-08-01)', () => {
  const PLACES = ['مدينة زايد العسكرية', 'Abu Dhabi'];

  it('finds the countries a headline names', () => {
    expect([...titleCountryRefs('Thirteen killed in Japan earthquake as search continues')]).toEqual(['JP']);
    expect(titleCountryRefs("Russia charges Telegram founder Durov with 'aiding terrorism'").has('RU')).toBe(true);
    expect(titleCountryRefs('UAE intercepts missile fired from Yemen').has('AE')).toBe(true);
    expect(titleCountryRefs('UAE intercepts missile fired from Yemen').has('YE')).toBe(true);
    // Acronyms are case-sensitive: "tell us more" is not the United States.
    expect(titleCountryRefs('Officials tell us more arrests are coming').size).toBe(0);
  });

  it('drops foreign-only headlines from a local assessment', () => {
    expect(isLocallyRelevant('Thirteen killed in Japan earthquake as search continues', 'AE', PLACES)).toBe(false);
    expect(isLocallyRelevant("Russia charges Telegram founder Durov with 'aiding terrorism'", 'AE', PLACES)).toBe(false);
  });

  it('keeps home-country, place-term, and no-country headlines', () => {
    expect(isLocallyRelevant('UAE intercepts missile fired from Yemen', 'AE', PLACES)).toBe(true);
    expect(isLocallyRelevant('Explosion reported near Abu Dhabi industrial zone in Iran-linked attack', 'AE', PLACES)).toBe(true);
    // No country claim at all — a purely local headline must never be dropped.
    expect(isLocallyRelevant('One killed, four injured after fires at Habshan gas facility', 'AE', PLACES)).toBe(true);
  });
});
