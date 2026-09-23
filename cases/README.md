# 干涉条纹簿离线案例包

- 包：干涉条纹簿：相位展开、支路切口与光学标定分支
- 基线：fringe-book-baseline（见 baseline.json）
- 情形：7 种，每种含最小输入与组合输入
- 重放：见 manifest.json 的 replay 段
- 生成：`node --experimental-strip-types cases/build/generate.ts`

所有样例为 10x10 像素的确定性解析公式帧，领域量携带单位与坐标基准。
