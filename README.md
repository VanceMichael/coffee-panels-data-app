# 咖啡杯测跨场可比性与采购复核

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

杯测量表存在 v1 与 v2，资料未约定二者固定换算。参照批由 blind-key 标识，同一杯测组内的盲样可有多位评审记录。withdrawn 在更新日后覆盖同一盲样此前的 valid，不能仅凭参照名称推断全部盲样无效。aroma 与 body 为独立项，defect 是杯级缺陷计数；空白是覆核不可读。rules 的 max_disagreement 为同盲样同量表杯间允许的最大差，超限须复核相应项。
订单的 band 是最低报价适用门槛，日期和批量均为实物约束。reserved 表示定金已支付、待正式签发，需占批量。lab-capacity 为当日总可用杯数，retest 是可申请安排及杯数。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。

## 杯测复核工具

在资料校验之上，`tools/cupping/` 提供可重复运行的跨场可比性与采购复核分析：杯次/盲样/实货批身份辨认、共同参照校准图、共享偏差区间、复判撤连影响、报价档判定、定金承诺台账、有限杯次的复测规划与角色视图。完整口径与 CLI 用法见 [`docs/cupping-tool.md`](docs/cupping-tool.md)。

```bash
npm run analyze                 # 完整分析（不含 events 事件目录）
node tools/cupping/cli.mjs --help
```
