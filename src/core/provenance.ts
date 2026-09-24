import { sha256 } from './hash.js';
import type { AlgorithmProvenance } from './types.js';

/** 统一的算法版本登记：重放时按此版本恢复规则 */
export const ALGORITHM_VERSIONS = {
  qualityMap: 'quality-map/1.0.0',
  residues: 'residue-detect/1.0.0',
  cutNetwork: 'branch-cut/1.0.0',
  components: 'connected-components/1.0.0',
  unwrap: 'quality-guided-tree/1.0.0',
  cycle: 'cycle-residual/1.0.0',
  height: 'phase-to-height/1.0.0',
} as const;

export function provenance(
  algorithm: string,
  algorithmVersion: string,
  parameters: Record<string, unknown>,
): AlgorithmProvenance {
  return {
    algorithm,
    algorithmVersion,
    parameters,
    parameterFingerprint: sha256(parameters, 12),
  };
}
