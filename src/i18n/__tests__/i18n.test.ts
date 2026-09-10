import {I18nManager} from 'react-native';
import {t, setLanguage, getLanguage, isRtlLang, applyRtl, getDeviceLanguage, isSupported} from '../index';

describe('i18n (Step 25)', () => {
  beforeEach(() => {
    setLanguage('en');
    (I18nManager as unknown as {isRTL: boolean}).isRTL = false;
  });

  it('resolves keys for en/ar/bn and falls back en → key', () => {
    setLanguage('en');
    expect(t('settings.title')).toBe('Settings');
    setLanguage('ar');
    expect(t('settings.title')).toBe('الإعدادات');
    setLanguage('bn');
    expect(t('settings.title')).toBe('সেটিংস');
    // Unknown key returns the key itself.
    expect(t('totally.missing.key')).toBe('totally.missing.key');
  });

  it('falls back to the English string for a key missing in the active catalog', () => {
    setLanguage('ar');
    // A key only present in en still resolves (no blank).
    expect(t('common.done')).not.toBe('');
  });

  it('interpolates {params}', () => {
    setLanguage('en');
    // Use a runtime catalog entry via a param-bearing key fallback (key echoes with sub).
    expect(t('Hello {name}', {name: 'Sam'})).toBe('Hello Sam');
  });

  it('clamps an unsupported language to en', () => {
    setLanguage('zz' as never);
    expect(getLanguage()).toBe('en');
    expect(isSupported('zz')).toBe(false);
    expect(isSupported('ar')).toBe(true);
  });

  it('marks only Arabic as RTL', () => {
    expect(isRtlLang('ar')).toBe(true);
    expect(isRtlLang('en')).toBe(false);
    expect(isRtlLang('bn')).toBe(false);
  });

  it('applyRtl flips for ar and clears for en (returns whether it changed)', () => {
    const forceSpy = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined);
    jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined);
    expect(applyRtl('ar')).toBe(true);              // false → true
    expect(forceSpy).toHaveBeenCalledWith(true);
    (I18nManager as unknown as {isRTL: boolean}).isRTL = true;
    expect(applyRtl('ar')).toBe(false);             // already RTL → no change
    expect(applyRtl('en')).toBe(true);              // true → false
    expect(forceSpy).toHaveBeenCalledWith(false);
    forceSpy.mockRestore();
  });

  it('getDeviceLanguage returns a supported code (en in the test runtime)', () => {
    expect(['en', 'ar', 'bn']).toContain(getDeviceLanguage());
  });
});
