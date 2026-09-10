/**
 * THE IMPORT WALL — can `productionRuntime.ts` be loaded by a test at all?
 *
 * For its whole life the answer has been no, and that — not its size — is
 * why the repo's most-churned source file has zero executable coverage
 * and why ~50 suites "cover" it by reading it as TEXT and regexing the
 * string. B-124/B-125 (CRITICAL data loss), B-337/B-339 and B-353 all
 * shipped through a fully green suite because nothing could run the code.
 *
 * The blocker was never architectural. The `messenger-crypto` project is
 * `testEnvironment: node` with a transform that skips
 * `node_modules/react-native`, whose entry point is Flow-typed ESM — so
 * ANY module whose import graph reaches `react-native` (or the JSI
 * `@op-engineering/op-sqlite`) is unloadable. `runtime/runtime.ts`, which
 * productionRuntime imports directly, is one of exactly 15 messenger
 * modules that import react-native, and the whole tree consumes only five
 * symbols from it. Two `moduleNameMapper` stubs close that gap.
 *
 * THIS TEST IS THE GATE ON THAT PROPERTY. It asserts nothing about
 * runtime behaviour — only that the module LOADS and exposes its entry
 * point. That is deliberate: importability is the precondition every
 * future behavioural test depends on, and it is the thing that silently
 * regresses the moment someone adds a native import to any module in the
 * chain. When that happens this test names the file and the specifier
 * instead of leaving the next engineer to rediscover the wall.
 *
 * Do NOT extend this suite into behavioural assertions against a runtime
 * built on the op-sqlite stub — that stub throws on every query by
 * design (see its header). Build behavioural tests against the real
 * seams, and let this one keep guarding the door.
 */

describe('productionRuntime import wall', () => {
  it('the module can be require()d without a native-module SyntaxError', () => {
    expect(() => require('../runtime/productionRuntime')).not.toThrow();
  });

  it('exposes buildProductionRuntime as a callable export', () => {
    const mod = require('../runtime/productionRuntime') as Record<string, unknown>;
    expect(typeof mod.buildProductionRuntime).toBe('function');
  });

  it('the react-native stub resolves to our mock, not the real package', () => {
    // Guards the moduleNameMapper entry itself. If it is removed, this
    // fails with the actual reason rather than a downstream mystery.
    const rn = require('react-native') as {Platform?: {OS?: string}};
    expect(rn.Platform).toBeDefined();
    expect(['android', 'ios']).toContain(rn.Platform!.OS);
  });

  it('the op-sqlite stub resolves and open() returns a handle', () => {
    const sqlite = require('@op-engineering/op-sqlite') as {
      open: (o: {name: string}) => {execute: unknown};
    };
    const handle = sqlite.open({name: 'probe.db'});
    expect(typeof handle.execute).toBe('function');
  });
});
