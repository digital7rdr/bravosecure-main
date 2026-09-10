import AsyncStorage from '@react-native-async-storage/async-storage';

// Persisted "this signup chose Service Provider" intent.
//
// Why a persisted flag and not just nav params: registration creates the user
// as role='individual' (the backend refuses a self-selected privileged role —
// security control P0-V1). The user only becomes 'service_provider' AFTER they
// create a company agent (POST /agents). Between signup and that step — and
// across an app restart in the middle of onboarding — the app must remember to
// route them into the provider/agent flow instead of the client home. This
// flag bridges that gap; it is cleared once the company agent exists (role flips).
const KEY = 'auth:pending_provider';

export const pendingProvider = {
  set: () => AsyncStorage.setItem(KEY, '1'),
  get: async (): Promise<boolean> => (await AsyncStorage.getItem(KEY)) === '1',
  clear: () => AsyncStorage.removeItem(KEY),
};
