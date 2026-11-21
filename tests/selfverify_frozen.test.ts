import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The self-verification tolerances and verdict rules are frozen. Changing
 * either file fails this test; update the hash only together with an entry
 * under "Tolerance changes" in docs/self-verify.md giving the derivation.
 */
const FROZEN: Record<string, string> = {
  'scripts/selfverify/tolerances.ts': '759ecdedaff49704',
  'scripts/selfverify/measure.ts': '3cdcf484c89c021d',
};

describe('self-verification thresholds are frozen', () => {
  for (const [path, hash] of Object.entries(FROZEN)) {
    it(`${path} is unchanged (see docs/self-verify.md, "Tolerance changes")`, () => {
      const actual = createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex').slice(0, 16);
      expect(actual).toBe(hash);
    });
  }
});
