import {Test, TestingModule} from '@nestjs/testing';
import {PasswordService}    from './password.service';

// Argon2 hashing is intentionally slow (m=65536 MiB) — extend timeout
jest.setTimeout(60_000);

describe('PasswordService', () => {
  let service: PasswordService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PasswordService],
    }).compile();
    service = module.get(PasswordService);
  });

  describe('hash()', () => {
    it('returns an argon2id hash string', async () => {
      const h = await service.hash('my-password');
      expect(h).toMatch(/^\$argon2id\$/);
    });

    it('produces different hashes for the same input (random salt)', async () => {
      const [h1, h2] = await Promise.all([
        service.hash('same-password'),
        service.hash('same-password'),
      ]);
      expect(h1).not.toBe(h2);
    });
  });

  describe('verify()', () => {
    it('returns true when plain matches the hash', async () => {
      const h = await service.hash('correct-horse-battery-staple');
      expect(await service.verify(h, 'correct-horse-battery-staple')).toBe(true);
    });

    it('returns false for the wrong password', async () => {
      const h = await service.hash('correct-horse');
      expect(await service.verify(h, 'wrong-horse')).toBe(false);
    });

    it('returns false for an empty string against a real hash', async () => {
      const h = await service.hash('nonempty');
      expect(await service.verify(h, '')).toBe(false);
    });
  });
});
