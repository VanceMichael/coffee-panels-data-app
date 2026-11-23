# 杯测跨场可比性与采购复核工具

面向长期合作社生豆采购的可重复运行分析工具。仅依赖 Node.js 标准库，相同输入必然产生相同输出（无时间戳、无随机数）。

## 业务口径与建模约定

### 1. 三层身份：杯次 → 盲样 → 实货批

- `cup`（杯次）是最小观测，`blind`（盲样）可对应多杯重复杯，`lot`（实货批）由 `blind-key` 映射。
- 同一盲样的多杯**只增加观测数，绝不产生多个供货批**；批次证据按盲样去重后汇总（`identity.mjs`）。
- 参照盲样 `lot` 为 `-`，只服务校准，不进入供货批。

### 2. 复判状态

- `withdrawn` 在 `updated_day` 当日起覆盖同一盲样此前的 `valid`，按 `analysisDay` 截止解析。
- 被撤除的**参照杯**整杯不可用（`REFERENCE_WITHDRAWN`）；被撤除的供货批盲样记 `KEY_WITHDRAWN`。
- 不能仅凭参照名称推断全部盲样无效：状态以盲样编号为单位解析。

### 3. 评审小组可比性（校准图）

- 图节点是 `小组@评分版本`（如 `B@v1`）。两个节点只有在**同评分版本 + 存在未撤除的共同参照**时才连边。
- 评分版本不同（v1/v2）即使共用参照也不可比：边标记 `rejected/VERSION_MISMATCH`，节点各自保留，资料未约定固定换算，不做换算。
- 连通分量内以第一个节点为锚（偏移 0），BFS 沿参照边传播小组偏移；边残差（环闭合）逐项输出，暴露 aroma/body 校准不一致。
- 没有有效边的分量是**未锚定分量**：原始量表内的数字保留，但采购判定经 `UNANCHORED_PANEL` 闸门一律挂起。

### 4. 区间结构（独立杯次噪声 + 场次/小组共享偏差）

对分量内每个数值项（aroma/body）：

```
调整值 = 原始分 - 小组偏移（未锚定分量偏移取 0）
点估计 = 调整值均值
SE     = sqrt( seCommon^2 + (sigma杯 / sqrt(n))^2 )
区间   = 点估计 ± z · SE
```

- `seCommon = max(sharedBiasFloor, 偏移传播标准误)`：场次/小组共享偏差，**不随杯数下降**。
- `sigma杯`：杯间合并标准差，带合同先验（`config/contract.json` 的 `variancePrior`），随重复杯数 n 收窄。
- `z` 默认 1.645，可在合同配置调整。显示小数位仅用于展示，判定从不靠增加小数位挑胜。
- 区间跨过门槛/报价档 → `INDETERMINATE`，理由码 `LIMIT_STRADDLE` / `BAND_STRADDLE`。
- 缺陷 `defect` 是计数项，不构造正态区间，按 `upper/lower` 合同限直接判。

### 5. 整杯不可用 vs 单项不可判

- 整杯不可用：盲样键缺失、参照/键被复判撤除（`unusable`）。
- 单项不可判：单元格空白（覆核不可读）→ 该测量项 `NO_EVIDENCE`，同杯其他项继续有效。
- 杯间差异超 `rules.max_disagreement` → 只挂起**该测量项**（`DISAGREEMENT_EXCEEDED`，scope=MEASURE），不连坐其他项，更不作废整杯。
- 同一批次证据落在互不连通分量上（如 L3 同时有 v1、v2）→ `DISJOINT_COMPONENTS`，分组结论各自保留，禁止合并成单一区间。

### 6. 采购判定与承诺台账

- 订单按货期（`available_day`/`delivery_day` ≤ `required_by`）、批量、报价档（`band`，对应 profile 主评分项）、目标风味规则分别判定。
- 状态：`ELIGIBLE` 可下订 / `ON_HOLD` 待补测或待量 / `FAIL` 不满足 / `COMMITTED` 定金承诺。
- `reserved`/`issued` 订单的批量进独立承诺台账，复核释放前任何其他订单不可移用。
- 开放订单按订单号确定性顺序做**整单**分配；余量不足整单时保留余量（`INSUFFICIENT`），不自动零拆。台账恒满足 `总量 = 承诺 + 已分配开放量 + 可分配余量`。

### 7. 复核规划（杯次预算有限）

- 每个 `retest` 选项先做容量校验（`cups_required ≤ lab-capacity.max_cups`），超限直接 `OVER_CAPACITY`。
- 参照类补测：投影哪些校准边会恢复、哪些因版本不同仍断开，并列出受影响订单——一次补参照可能让多个报价恢复可判。
- 批次类补测：只收紧该批次单测量项的杯次标准误，连通性不变。
- 同杯次预算下的二选一在 `schedules.conflicts` 显式列出牺牲的机会。
- 工具**不虚构补测分数**：恢复连通是结构结论，最终判定以录入的复判回报重算为准（`NO_FABRICATION`）。

### 8. 复判影响与角色视图

- `impact` 对比两个分析日报告：输出边增删、锚丢失、必须重出的结论、买手暂缓/停止/继续清单、实验室重出清单。
- 三种视图：`supplier` 仅自有批次状态与理由（脱敏偏移量与其他批次）；`lab` 盲样/复判/校准/复测；`internal` 全量工作视图。
- `trace-order` 把采购查询追到具体杯次、评分版本、报价档、合同规则与盲样键状态。

## 目录结构

```
config/contract.json        杯测合同参数（分析日、z、共享偏差下限、方差先验、主评分项）
events/                     事件目录（新盲样/复判回报），基础 fixtures 永不改写
tools/cupping/
  csv.mjs                   严格无引号 CSV 读写
  ingest.mjs                基础资料 + 事件装载、引用校验
  identity.mjs              杯次/盲样/批次身份、复判状态、杯可用性
  calibration.mjs           校准图、连通分量、偏移、区间
  rules.mjs                 杯间差异、合同规则、报价档、订单判定、承诺台账
  retest.mjs                复测容量、结构投影、机会成本、日程
  impact.mjs                两时点报告对比
  views.mjs                 supplier/lab/internal 视图
  trace.mjs                 订单/批次溯源
  analysis.mjs              主编排
  cli.mjs                   CLI 入口
test/cupping.test.mjs       23 项规则测试
```

## CLI 用法

```bash
# 完整分析（忽略 events 目录）
node tools/cupping/cli.mjs analyze --data fixtures --events false
node tools/cupping/cli.mjs analyze --day 8            # 复判前时点
node tools/cupping/cli.mjs analyze --out report.json  # 写文件

# 两时点复判影响
node tools/cupping/cli.mjs impact --before r-d8.json --after r-d12.json

# 溯源与角色视图
node tools/cupping/cli.mjs trace-order --order P3 --data fixtures --events false
node tools/cupping/cli.mjs view --role supplier --supplier F2 --data fixtures --events false
node tools/cupping/cli.mjs view --role lab --data fixtures --events false
node tools/cupping/cli.mjs view --role internal --data fixtures --events false

# 实验室录入（追加事件，不改基础资料）
node tools/cupping/cli.mjs add-blind --blind X90 --lot L2 --cup C90 \
  --session B --judge J4 --version v1 --aroma 8.8 --body 8.6 --defect 0 --day 11
node tools/cupping/cli.mjs add-retest --blind X02 --day 10   # 复判撤回
```

事件文件命名 `<前缀>.<表名>.csv` 或 `<前缀>-<表名>.csv`，表头与 `fixtures/format.json` 约定一致；`events/example.*.csv` 是自带示例。

## 本批合成资料的复核结论（analysisDay=12）

- 复判后 A、B、C 三个小组全部未锚定：R1 在 B 侧盲样 day9 全撤，A/B 桥断开；R3 跨 v1/v2 本就不可比。
- L1（A/v1）：双杯重复杯，香气区间跨过 8.5 档，挂起；P1 定金 300kg 独立锁定，余 180kg 不足 P2 的 250kg，P2 待量。
- L2（B/v1）：单杯香气 8.5 压线，区间跨档不可挑胜；R02 直补只收紧本批。
- L3：v1（B）与 v2（C）证据不连通分组保留；X05 的 body 空白只挂 body 单项；X05 defect 杯间差 1 超合同且观测到缺陷计数 1，P4 缺陷要求 FAIL。
- 复测：R01（补 R2，A|B，2 杯）可结构性恢复 A/B 桥、覆盖最多挂起订单；与 R02 在 day10 容量 3 下二选一；R03 需 4 杯超 day11 容量 3，且 B/C 版本不同补了也不可比。

## 测试

```bash
npm test               # 23 项规则测试 + 原有资料校验
npm run check:materials
```
