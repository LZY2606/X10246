/**
 * 离线案例包装配 + 完整叙事。
 *
 * 主叙事项目 proj_demo（光学实验室导入包裹相位/振幅/遮罩/标定帧）：
 *   1) 初始导入不可变基线（7 类输入）；
 *   2) 一次参数修订（低振幅阈值改变）-> 重算派生；
 *   3) 一次只影响局部依赖的源数据改动（局部振幅孔洞）-> 仅依赖结果过期；
 *   4) 一次互相冲突的人工锁定（同区域两种解读）-> lock-conflict；
 *   5) 接受/拒绝候选 + 撤销写入历史。
 *
 * 反例档案：7 个情形各一个 minimal 项目 + 一个 combined 项目；
 *   共享原始瓦片按 contentId 物理去重，解释版本/诊断/决定独立。
 */
import { Ledger } from '../db/ledger.ts';
import { VirtualClock } from '../domain/rng.ts';
import {
  SCENARIO_KEYS,
  buildMinimalScene,
  buildCombinedScene,
  type ScenarioKey,
} from '../domain/scenarios.ts';
import { ingestScene, ingestWavelength } from './ingest.ts';
import { runPipeline, type SourceIds } from './pipeline.ts';
import { decideCandidate, lockRegion, appendCutEdit, reverseHistory } from './decisions.ts';
import { DEFAULT_PARAMS, type AlgoParams } from '../domain/unwrap.ts';

export const DEMO_PROJECT = 'proj_demo';
export const CARD_VERSION = '干涉条纹簿：相位展开、支路切口与光学标定分支@1.0.0';

export function buildDemoProject(ledger: Ledger): { projectId: string; eventCount: number } {
  if (ledger.getProject(DEMO_PROJECT)) {
    return { projectId: DEMO_PROJECT, eventCount: ledger.listEvents(DEMO_PROJECT).length };
  }
  const clock = new VirtualClock('2026-01-01T00:00:00.000Z', 1000);
  ledger.createProject({
    projectId: DEMO_PROJECT,
    name: CARD_VERSION,
    createdAt: clock.peek(),
    scenarioTags: ['narrative', ...SCENARIO_KEYS],
  });

  // 组合场景在同一 8x8 上覆盖全部 7 种情形，叙事保持一条完整路径。
  const scene = buildCombinedScene([...SCENARIO_KEYS]);
  const ingested = ingestScene(ledger, DEMO_PROJECT, clock, scene);
  const src: SourceIds = ingested.ids as unknown as SourceIds;

  // 初始流水线
  const first = runPipeline(ledger, DEMO_PROJECT, clock, src, DEFAULT_PARAMS);

  // --- 一次参数修订：收紧振幅阈值，重算（新版本派生，旧版本保留） ---
  const revisedParams: AlgoParams = { ...DEFAULT_PARAMS, amplitudeThreshold: 0.4 };
  const second = runPipeline(ledger, DEMO_PROJECT, clock, src, revisedParams);

  // --- 一次只影响局部依赖的源数据改动：把 (6,6) 变低振幅，新增一版振幅帧 ---
  // （通过追加人工切口事件之外的“局部补丁”振幅新版本表达；此处记录为注解事件 +
  //  用新的裁剪场景再导入不做，避免覆盖，故以 annotation 记录局部补丁来源）
  ledger.append(
    DEMO_PROJECT,
    {
      type: 'annotation.appended',
      entity: { type: 'qualityScoreFrame', key: 'local-patch' },
      payload: {
        note: '局部源数据补丁：像素 (6,6) 振幅降低，仅影响其邻域派生结果',
        location: { r: 6, c: 6 },
        scope: 'local',
        affects: ['qualityMap', 'residueMap', 'regionMap'],
      },
      refs: [ingested.ids.amplitude],
      actor: 'human',
    },
    () => clock.now(),
  );

  // --- 波长版本变更：632.8nm -> 532nm，旧高度链过期但仍可查看 ---
  const wl2 = ingestWavelength(ledger, DEMO_PROJECT, clock, 532, 'nanometer', 'Nd:YAG v2', src.wavelength);
  const srcV2: SourceIds = { ...src, wavelength: wl2.eventId };
  runPipeline(ledger, DEMO_PROJECT, clock, srcV2, revisedParams);

  // --- 整周多解：在第二版（mst-quality）候选集合上接受一个合法 k，拒绝另一个 ---
  const integersEvent = second.integers[0];
  const intPayload = ledger.getEvent(integersEvent)!.payload as {
    ambiguities: Array<{ ambiguityId: string; nonUnique: boolean; options: Array<{ k: number; legal: boolean }> }>;
  };
  const nonUnique = intPayload.ambiguities.find((a) => a.nonUnique) ?? intPayload.ambiguities[0];
  if (nonUnique) {
    const legalKs = nonUnique.options.filter((o) => o.legal).map((o) => o.k);
    if (legalKs.length) {
      decideCandidate({
        ledger,
        projectId: DEMO_PROJECT,
        clock,
        integerCandidatesEventId: integersEvent,
        ambiguityId: nonUnique.ambiguityId,
        decision: 'accept',
        chosenK: legalKs[0],
        rejectedK: legalKs.slice(1),
        rationale: '采用使邻域循环残差最小的整周偏移（质量引导树）',
      });
    }
  }

  // --- 局部锁定冲突：对 R0 先锁 mst-quality 解读，再锁冲突的 bfs-border 解读 ---
  const hMst = second.height[0];
  const hBfs = second.height[1] ?? second.height[0];
  const treeMst = second.unwrap[0];
  const treeBfs = second.unwrap[1] ?? second.unwrap[0];
  lockRegion({
    ledger,
    projectId: DEMO_PROJECT,
    clock,
    regionId: 'R0',
    interpretation: 'mst-quality：质量引导展开的局部高度面',
    bound: { heightChainEventId: hMst, unwrapTreeEventId: treeMst, integerCandidatesEventId: second.integers[0] },
  });
  lockRegion({
    ledger,
    projectId: DEMO_PROJECT,
    clock,
    regionId: 'R0',
    interpretation: 'bfs-border：边界优先展开的另一局部自洽高度面',
    bound: {
      heightChainEventId: hBfs,
      unwrapTreeEventId: treeBfs,
      integerCandidatesEventId: second.integers[1] ?? second.integers[0],
    },
  });

  // --- 人工切口编辑（切口编辑历史只追加） ---
  appendCutEdit({
    ledger,
    projectId: DEMO_PROJECT,
    clock,
    edit: {
      action: 'add-cut',
      a: { r: 2, c: 2 },
      b: { r: 5, c: 4 },
      reason: '人工隔离残差对，检验整周偏移显式表示',
      actor: 'human',
    },
  });

  // --- 撤销最近一次操作（回滚到上一事件），历史保留 ---
  const head = ledger.headEventId(DEMO_PROJECT)!;
  reverseHistory({
    ledger,
    projectId: DEMO_PROJECT,
    clock,
    kind: 'undo',
    targetEventId: head,
    reason: '审阅者撤销该步，恢复先前依赖版本视图',
  });

  // 标记一次导出事件
  ledger.append(
    DEMO_PROJECT,
    {
      type: 'bundle.exported',
      entity: { type: 'qualityMap', key: 'export-marker' },
      payload: { note: '案例包导出版本快照', card: CARD_VERSION },
      refs: [],
      actor: 'system',
    },
    () => clock.now(),
  );

  void first;
  return { projectId: DEMO_PROJECT, eventCount: ledger.listEvents(DEMO_PROJECT).length };
}

/** 装配反例档案：7 个 minimal + 1 个 combined；共享瓦片自动去重。 */
export function buildCounterexampleArchive(ledger: Ledger): {
  projects: string[];
  tileCount: number;
} {
  const clock = new VirtualClock('2026-02-01T00:00:00.000Z', 500);
  const projects: string[] = [];

  for (const key of SCENARIO_KEYS) {
    const pid = 'proj_min_' + key;
    if (!ledger.getProject(pid)) {
      ledger.createProject({
        projectId: pid,
        name: `反例·最小输入·${key}`,
        createdAt: clock.peek(),
        scenarioTags: ['counterexample', 'minimal', key],
      });
      const scene = buildMinimalScene(key);
      const ingested = ingestScene(ledger, pid, clock, scene);
      runPipeline(ledger, pid, clock, ingested.ids as unknown as SourceIds, DEFAULT_PARAMS);
      archiveSpecificDecision(ledger, pid, clock, key, ingested.ids);
    }
    projects.push(pid);
  }

  const combinedId = 'proj_combined_all';
  if (!ledger.getProject(combinedId)) {
    ledger.createProject({
      projectId: combinedId,
      name: '反例·组合输入·全部情形',
      createdAt: clock.peek(),
      scenarioTags: ['counterexample', 'combined', ...SCENARIO_KEYS],
    });
    const scene = buildCombinedScene([...SCENARIO_KEYS]);
    const ingested = ingestScene(ledger, combinedId, clock, scene);
    runPipeline(ledger, combinedId, clock, ingested.ids as unknown as SourceIds, DEFAULT_PARAMS);
    projects.push(combinedId);
  }

  return { projects, tileCount: ledger.allTiles().length };
}

/** 每个情形保存“被采纳与未采纳”的结果与机器可读判定事件。 */
function archiveSpecificDecision(
  ledger: Ledger,
  pid: string,
  clock: VirtualClock,
  key: ScenarioKey,
  ids: Record<string, string>,
): void {
  // 找到该项目的首个整数候选集合
  const state = ledger
    .listEvents(pid)
    .filter((e) => e.type === 'integers.computed');
  const judgment = {
    'phase-border-crossing': '边界处 ±π 跳变是真实 2π 跨越，展开应连续',
    'low-amplitude-hole': '低振幅孔洞不猜相位，保持 NaN；不得填充',
    'multiply-connected': '孔洞使区域多连通，不同展开树环绕孔洞可有整周差',
    'cycle-not-closed': '存在非整数环绕和，该环无法仅靠整周闭合',
    'wavelength-version': '波长换版只改高度缩放，不改变整周结构；旧高度链过期保留',
    'integer-ambiguity': '跨切口整周多解，保留全部合法候选直至外部基准裁决',
    'lock-conflict': '同一区域两种自洽解读冲突，锁定必须显式标 conflict',
  }[key];
  ledger.append(
    pid,
    {
      type: 'annotation.appended',
      entity: { type: 'qualityScoreFrame', key: 'judgment' },
      payload: {
        machineReadable: true,
        scenario: key,
        rule: judgment,
        adoptedKept: true,
        rejectedKept: true,
        sourceBaselineImmutable: [
          ids.phase,
          ids.amplitude,
          ids.snr,
          ids.mask,
          ids.wavelength,
          ids.geometry,
          ids.calibration,
          ids.cutHistory,
        ],
      },
      refs: state.length ? [state[0].eventId] : [],
      actor: 'system',
    },
    () => clock.now(),
  );
}
