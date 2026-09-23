#!/usr/bin/env node
// 测试入口：接受固定演示命令里透传的 `--run`（npm 标志），随后一次性运行测试并退出。
// 固定 seed / 临时目录 / 虚拟时间均在测试内部处理；不访问公网。
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const args = process.argv.slice(2).filter((a) => a !== '--run');
const testDir = resolve('./test');
let files = args.length
  ? args
  : readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).map((f) => resolve(testDir, f));

const stream = run({ files, concurrency: 1 });
let failures = 0;
stream.compose(spec).pipe(process.stdout);
stream.on('test:fail', () => {
  failures += 1;
});
await new Promise((r) => stream.on('end', r));
process.exitCode = failures === 0 ? 0 : 1;
