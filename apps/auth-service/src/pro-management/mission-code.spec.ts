import {mintMissionCode} from './pro-management.service';

describe('mintMissionCode', () => {
  it('always matches the gate regex the resolver enforces', () => {
    for (let i = 0; i < 500; i++) {
      expect(mintMissionCode()).toMatch(/^PMC-[A-Z2-9]{6}$/);
    }
  });

  it('never emits 0/O/1/I lookalikes (hand-typed on a phone)', () => {
    for (let i = 0; i < 500; i++) {
      const body = mintMissionCode().slice(4);
      expect(body).not.toMatch(/[01OI]/);
    }
  });
});
