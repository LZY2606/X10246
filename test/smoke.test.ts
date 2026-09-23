import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerStore } from '../src/shared/store/sqlite-store';
import { LedgerService } from '../src/shared/domain/ledger-service';

let dir: string;
let dbPath: string;
let service: LedgerService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-smoke-'));
  dbPath = join(dir, 'test.sqlite');
  service = new LedgerService(new LedgerStore(dbPath), { seed: 20260924 });
});
afterEach(() => {
  service.store.close();
  rmSync(dir, { recursive: true, force: true });
});

const load = (f: string) => JSON.parse(readFileSync(join(process.cwd(), 'cases', f), 'utf8'));

describe('smoke', () => {
  it('imports baseline and runs the pipeline', () => {
    const bundle = load('baseline.json');
    const imported = service.importCase(bundle);
    expect(imported.committed).toHaveLength(7);
    const result = service.commitDerivedPipeline('fringe-book-baseline');
    const kinds = result.committed.map((c) => c.envelope.kind);
    expect(kinds).toContain('quality_map');
    expect(kinds).toContain('residue_map');
    expect(kinds).toContain('cut_network');
    expect(kinds).toContain('unwrap_tree');
    expect(kinds).toContain('cycle_residual');
    expect(kinds).toContain('integer_candidate_set');
    expect(result.heights.length).toBeGreaterThan(0);
  });
});
