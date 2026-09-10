/**
 * NAV-13/NAV-21 (2026-08-26 rapid-use audit) — the money-adjacent SecurePro
 * mutators relied on `disabled={isSubmitting}`, which needs a committed
 * re-render and is late precisely when the JS thread is lagging (the founder's
 * ×20-tap repro). The store now bails out on a SYNCHRONOUS `get().isSubmitting`
 * read, and `loadApplication` dedupes concurrent callers onto one live request
 * (useProPlanGate re-fires it from ~9 screens on every focus).
 */
jest.mock('@services/api', () => ({
  secureProApi: {
    me: jest.fn(),
    create: jest.fn(),
    renew: jest.fn(),
    cancel: jest.fn(),
    accept: jest.fn(),
    requestChanges: jest.fn(),
    activate: jest.fn(),
    messages: jest.fn(),
    sendMessage: jest.fn(),
  },
}));

import {useSecureProStore} from '@store/secureProStore';
import {secureProApi} from '@services/api';

type Deferred<T> = {promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

const APP = {id: 'app-1', status: 'PROPOSED'} as never;

beforeEach(() => {
  jest.clearAllMocks();
  useSecureProStore.setState({
    application: APP,
    history: [],
    messages: [],
    isLoading: false,
    isSubmitting: false,
    hasLoaded: false,
    error: null,
  } as never);
});

describe('NAV-13 — a tap burst fires exactly one mutation', () => {
  it('acceptProposal: the repeat THROWS — it must never resolve into the caller\'s success path', async () => {
    // Critic finding: `await acceptProposal(); navigation.replace(...)` — a
    // silently-resolving repeat would navigate to Payment before the REAL
    // accept settled. The throw is swallowed by every caller's catch.
    const d = deferred<{data: {application: unknown}}>();
    (secureProApi.accept as jest.Mock).mockReturnValue(d.promise);
    const s = useSecureProStore.getState();
    const first = s.acceptProposal();
    await expect(s.acceptProposal()).rejects.toThrow('Already processing.');
    d.resolve({data: {application: APP}});
    await first;
    expect(secureProApi.accept).toHaveBeenCalledTimes(1);
  });

  it('activate: the repeat throws (silently swallowed by callers) and never reaches the API', async () => {
    const d = deferred<{data: {application: unknown}}>();
    (secureProApi.activate as jest.Mock).mockReturnValue(d.promise);
    const s = useSecureProStore.getState();
    const first = s.activate();
    await expect(s.activate()).rejects.toThrow('Already processing.');
    d.resolve({data: {application: APP}});
    await first;
    expect(secureProApi.activate).toHaveBeenCalledTimes(1);
  });

  it('the guard re-arms after settlement — the NEXT deliberate tap still works', async () => {
    (secureProApi.accept as jest.Mock).mockResolvedValue({data: {application: APP}});
    const s = useSecureProStore.getState();
    await s.acceptProposal();
    await s.acceptProposal();
    expect(secureProApi.accept).toHaveBeenCalledTimes(2);
  });
});

describe('NAV-21 — loadApplication dedupes concurrent focus refires', () => {
  it('N concurrent callers share ONE /pro-applications/me request', async () => {
    const d = deferred<{data: {application: unknown; history: unknown[]}}>();
    (secureProApi.me as jest.Mock).mockReturnValue(d.promise);
    const s = useSecureProStore.getState();
    const calls = [s.loadApplication(), s.loadApplication(), s.loadApplication()];
    d.resolve({data: {application: APP, history: []}});
    await Promise.all(calls);
    expect(secureProApi.me).toHaveBeenCalledTimes(1);
    expect(useSecureProStore.getState().hasLoaded).toBe(true);
  });

  it('stale-while-revalidate survives: a LATER call refetches', async () => {
    (secureProApi.me as jest.Mock).mockResolvedValue({data: {application: APP, history: []}});
    const s = useSecureProStore.getState();
    await s.loadApplication();
    await s.loadApplication();
    expect(secureProApi.me).toHaveBeenCalledTimes(2);
  });
});
