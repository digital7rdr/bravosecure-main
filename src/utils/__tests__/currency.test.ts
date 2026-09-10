import {currencyForRegion, formatCurrency} from '../currency';

describe('currencyForRegion (Step 25)', () => {
  it('maps each launch region to its currency', () => {
    expect(currencyForRegion('AE')).toBe('AED');
    expect(currencyForRegion('SA')).toBe('SAR');
    expect(currencyForRegion('BD')).toBe('BDT');
    expect(currencyForRegion('GB')).toBe('GBP');
  });

  it('is case-insensitive and defaults to AED for unknown/blank', () => {
    expect(currencyForRegion('ae')).toBe('AED');
    expect(currencyForRegion('ZZ')).toBe('AED');
    expect(currencyForRegion(undefined)).toBe('AED');
    expect(currencyForRegion(null)).toBe('AED');
  });
});

describe('formatCurrency (BC peg)', () => {
  it('renders the amount in Bravo Credits regardless of region', () => {
    expect(formatCurrency(1234, 'AE')).toBe('1,234 BC');
    expect(formatCurrency(1234, 'GB')).toBe('1,234 BC');
    expect(formatCurrency(1000, 'BD')).toBe('1,000 BC');
    expect(formatCurrency(500, 'SA')).toBe('500 BC');
  });

  it('rounds fractional amounts and handles unknown/blank regions', () => {
    expect(formatCurrency(2000.4, 'ZZ')).toBe('2,000 BC');
    expect(formatCurrency(999.6)).toBe('1,000 BC');
  });
});
