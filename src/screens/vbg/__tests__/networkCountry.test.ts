/**
 * The radio-country reader is the rung that fixes the reported defect without
 * any permission, so its failure modes matter more than its happy path: a
 * garbage value reaching the ladder would pin the WRONG emergency numbers with
 * full "Your mobile network" confidence.
 */
import {NativeModules} from 'react-native';
import {getRadioCountry} from '../networkCountry';

const mod = () => (NativeModules as unknown as Record<string, unknown>).BravoNetworkCountry;
const setMod = (v: unknown) => {
  (NativeModules as unknown as Record<string, unknown>).BravoNetworkCountry = v;
};

describe('getRadioCountry', () => {
  afterEach(() => { setMod(undefined); });

  it('returns the serving-network and SIM countries, upper-cased', () => {
    setMod({getCountry: async () => ({network: 'ae', sim: 'gb'})});
    return expect(getRadioCountry()).resolves.toEqual({network: 'AE', sim: 'GB'});
  });

  it.each([
    ['an empty string',      ''],
    ['the unknown marker',   '--'],
    ['a three-letter code',  'ARE'],
    ['a numeric MCC',        '424'],
    ['whitespace',           '  '],
    ['null',                 null],
    ['a non-string',         42],
  ])('rejects %s rather than passing it to the ladder', (_label, raw) => {
    setMod({getCountry: async () => ({network: raw, sim: raw})});
    return expect(getRadioCountry()).resolves.toEqual({network: null, sim: null});
  });

  it('trims and normalises a padded code', () => {
    setMod({getCountry: async () => ({network: ' de ', sim: null})});
    return expect(getRadioCountry()).resolves.toEqual({network: 'DE', sim: null});
  });

  it('is silent when the native module is absent (iOS, or an older build)', () => {
    setMod(undefined);
    expect(mod()).toBeUndefined();
    return expect(getRadioCountry()).resolves.toEqual({network: null, sim: null});
  });

  it('is silent when the module exists but lacks the method', () => {
    setMod({});
    return expect(getRadioCountry()).resolves.toEqual({network: null, sim: null});
  });

  it('never rejects when the bridge call throws — an emergency screen cannot depend on it', () => {
    setMod({getCountry: async () => { throw new Error('bridge down'); }});
    return expect(getRadioCountry()).resolves.toEqual({network: null, sim: null});
  });

  it('survives a malformed payload', () => {
    setMod({getCountry: async () => null});
    return expect(getRadioCountry()).resolves.toEqual({network: null, sim: null});
  });
});
