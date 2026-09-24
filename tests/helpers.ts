import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, VirtualClock } from '../src/server/store.js';

export const TEST_SEED = 1217;

export interface TestContext {
  dir: string;
  store: Store;
  clock: VirtualClock;
  cleanup: () => void;
}

export function makeStore(name: string): TestContext {
  const dir = mkdtempSync(join(tmpdir(), `ibook-${name}-`));
  const clock = new VirtualClock();
  const store = new Store(join(dir, 'test.db'), clock);
  return {
    dir,
    store,
    clock,
    cleanup: () => {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
