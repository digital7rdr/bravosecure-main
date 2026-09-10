import {ExecutionContext, NotFoundException} from '@nestjs/common';
import type {ConfigService} from '@nestjs/config';
import {DeptChatV2Guard} from './dept-chat-v2.guard';

const ctx = {} as ExecutionContext; // the guard ignores the context
const guardWith = (flag: boolean) =>
  new DeptChatV2Guard({get: () => flag} as unknown as ConfigService);

describe('DeptChatV2Guard', () => {
  it('404s (feature invisible) when DEPT_CHAT_V2 is off', () => {
    expect(() => guardWith(false).canActivate(ctx)).toThrow(NotFoundException);
  });

  it('lets the request through when the flag is on', () => {
    expect(guardWith(true).canActivate(ctx)).toBe(true);
  });
});
