/**
 * Unit tests for userService.uploadAvatar — the Supabase Storage avatar upload
 * used by the shared useAvatarPicker hook (individual / CPO / service-provider).
 *
 * These were written against the ORIGINAL flow (anon-key `storage.upload()` +
 * `getPublicUrl()`). DC-21 replaced that — the anon key is extractable, so
 * anyone holding it could overwrite any user's avatar — with a service-role
 * signed upload URL minted by the `avatar-upload-url` edge function, which
 * verifies the Bravo JWT and scopes the token to the caller's OWN path.
 *
 * The mocks were never updated, so every case failed on a real network call
 * ("Failed to send a request to the Edge Function") and the suite had been red
 * ever since. Updated to the current flow, and extended to pin the DC-21
 * properties that make it a security fix rather than a refactor: the request is
 * authenticated with the stored token, and the upload rides the signed token
 * rather than the anon key.
 */

// Decode is irrelevant to the assertions; return a stable buffer.
jest.mock('base64-arraybuffer', () => ({
  decode: () => new Uint8Array([1, 2, 3]).buffer,
}));

// Avoid pulling the real constants module (it transitively loads an untransformed
// Expo ESM env shim under jest).
jest.mock('@utils/constants', () => ({SUPABASE_URL: 'http://test', SUPABASE_ANON_KEY: 'anon'}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {getItem: jest.fn(async () => 'jwt-token')},
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {userService, supabase} from '@/services/supabase';

const mockUploadToSignedUrl = jest.fn();
const mockInvoke = jest.fn();
const mockStorageFrom = jest.fn(() => ({uploadToSignedUrl: mockUploadToSignedUrl}));

const SIGNED = {
  path:      'u1/avatar.jpg',
  token:     'one-shot-token',
  publicUrl: 'https://cdn.test/storage/v1/object/public/avatars/u1/avatar.jpg',
};

describe('userService.uploadAvatar', () => {
  beforeEach(() => {
    mockUploadToSignedUrl.mockReset().mockResolvedValue({error: null});
    mockInvoke.mockReset().mockResolvedValue({data: SIGNED, error: null});
    mockStorageFrom.mockClear();
    (AsyncStorage.getItem as jest.Mock).mockReset().mockResolvedValue('jwt-token');
    // `supabase.functions` and `supabase.storage` are GETTERS that construct a
    // fresh client on every access, so `jest.spyOn(supabase.functions, 'invoke')`
    // patches a throwaway instance and the real one still fires a network call.
    // That is why this suite failed with "Failed to send a request to the Edge
    // Function" rather than with an assertion. Override the accessors instead.
    Object.defineProperty(supabase, 'functions', {
      configurable: true,
      get: () => ({invoke: mockInvoke}),
    });
    Object.defineProperty(supabase, 'storage', {
      configurable: true,
      get: () => ({from: mockStorageFrom}),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (supabase as unknown as Record<string, unknown>).functions;
    delete (supabase as unknown as Record<string, unknown>).storage;
  });

  it('asks the edge function for a signed URL and returns a cache-busted public URL', async () => {
    const url = await userService.uploadAvatar('u1', 'AAAA', 'image/jpeg');

    expect(mockInvoke).toHaveBeenCalledWith('avatar-upload-url', expect.objectContaining({
      body: {ext: 'jpg'},
    }));
    expect(mockStorageFrom).toHaveBeenCalledWith('avatars');
    expect(mockUploadToSignedUrl).toHaveBeenCalledWith(
      SIGNED.path,
      SIGNED.token,
      expect.anything(),
      {contentType: 'image/jpeg', upsert: true},
    );
    expect(url).toMatch(
      /^https:\/\/cdn\.test\/storage\/v1\/object\/public\/avatars\/u1\/avatar\.jpg\?v=\d+$/,
    );
  });

  it('DC-21 — the signing request carries the caller\'s bearer token', () => {
    // Without this the edge function cannot tell WHICH user is asking, and the
    // per-user path scoping that replaced the anon key means nothing.
    return userService.uploadAvatar('u1', 'AAAA', 'image/jpeg').then(() => {
      expect(mockInvoke).toHaveBeenCalledWith('avatar-upload-url', expect.objectContaining({
        headers: {Authorization: 'Bearer jwt-token'},
      }));
    });
  });

  it('maps mime type to the right extension', async () => {
    await userService.uploadAvatar('u1', 'AAAA', 'image/png');
    expect(mockInvoke).toHaveBeenLastCalledWith('avatar-upload-url', expect.objectContaining({
      body: {ext: 'png'},
    }));

    await userService.uploadAvatar('u1', 'AAAA', 'image/webp');
    expect(mockInvoke).toHaveBeenLastCalledWith('avatar-upload-url', expect.objectContaining({
      body: {ext: 'webp'},
    }));

    // Anything else falls back to jpg rather than inventing an extension.
    await userService.uploadAvatar('u1', 'AAAA', 'image/heic');
    expect(mockInvoke).toHaveBeenLastCalledWith('avatar-upload-url', expect.objectContaining({
      body: {ext: 'jpg'},
    }));
  });

  it('throws when the upload fails', async () => {
    mockUploadToSignedUrl.mockResolvedValueOnce({error: new Error('storage_full')});
    await expect(userService.uploadAvatar('u1', 'AAAA', 'image/jpeg')).rejects.toThrow('storage_full');
  });

  it('throws when the edge function refuses to sign, and never uploads', async () => {
    mockInvoke.mockResolvedValueOnce({data: null, error: new Error('unauthorised')});
    await expect(userService.uploadAvatar('u1', 'AAAA', 'image/jpeg')).rejects.toThrow('unauthorised');
    expect(mockUploadToSignedUrl).not.toHaveBeenCalled();
  });
});
