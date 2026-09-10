import {Injectable} from '@nestjs/common';

// Plan spec: m=64 MiB, t=3, p=4.
// Options are built lazily so the argon2 native module is never touched
// during test module initialisation (where it may not be available).
async function getOptions() {
  const argon2 = await import('argon2');
  return {
    type:        argon2.argon2id,
    memoryCost:  65_536,
    timeCost:    3,
    parallelism: 4,
  };
}

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    const argon2 = await import('argon2');
    return argon2.hash(plain, await getOptions());
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    const argon2 = await import('argon2');
    return argon2.verify(hash, plain);
  }
}
