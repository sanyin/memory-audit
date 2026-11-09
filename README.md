# memory-audit

把 agent 的记忆摊开：**写在第几轮、还在不在、有没有被用过、和谁打架**。

读会话记录 + 记忆库，输出一份可以逐条回溯到原始 `seq` 的账本，而不是一段总结。

```
记忆审计 · session-b3ea911a · 44 轮 · 21.4M 字符
  记忆单元 19（决策 0 / 要求 17 / 目标 2）
  冲突 0
  被重复说过 2 条 · 无强证据 8 条 · 压缩遗忘 9 条（2583 tokens）
  压缩保真度：摘要保留 3 条 / 丢弃 6 条（依据 1 份摘要）
  技能 155 装 / 1 用
```

## 快速开始

```bash
node src/cli.mjs <session.jsonl.zstd> --open
node src/cli.mjs --latest                        # 自动挑最近一次 DSH 会话
node src/cli.mjs session.jsonl -m ./MEMORY.md    # 加上外部记忆库（markdown 列表项）
node src/cli.mjs session.jsonl --prov prov.json  # 导出 W3C PROV-JSON
node src/cli.mjs examples/demo-postgres-sqlite.jsonl --open
```

零依赖，Node ≥ 22。产物：`audit-out/<session-id>.html`（可视化），可选 `--json`（完整数据）与 `--prov`（标准溯源）。

## 它回答的三个问题

| 问题 | 怎么答 | 例子 |
| --- | --- | --- |
| 记住了什么 | 从用户消息、压缩摘要、目标记录、记忆文件抽出「记忆单元」，原样引用 | `第 3 轮「存储用 Postgres，不要换。」` |
| 哪一轮写进去的 | 每个单元带 `turn` / `seq` / 时间 / 通道 | 账本第一列 |
| 有没有被用过 | 三级证据，逐轮对齐 | 复述 4 轮 / 术语共现 9 轮 / 写进工具调用 0 轮 |
| 有没有打架 | 同槽位、不同取值的两条断言 | `第 9 轮写入「改用 SQLite」与第 3 轮冲突；此后 12 轮：Postgres 4 轮，SQLite 0 轮` |

## 证据分级（本工具的核心取舍）

一份审计报告最危险的地方，是它看起来有出处，其实没有。所以「用过」被拆成三个强度不同的证据：

| 等级 | 含义 | 强度 |
| --- | --- | --- |
| 写进工具调用 | 该值出现在本轮 `tool/call` 参数里——真的落到了动作上 | 最强 |
| 逐字复述 | 单元里 8 字以上的片段原样出现在模型产出里 | 强 |
| 术语共现 | 同一槽位词出现在本轮产出里（**可能正在否定它**） | 弱 |
| 仅在上下文 | 只在 `liveTurns` 里存在过 | 不算「用过」 |

三档分开计数，不合并成一个好看的总数。

## 它明确不做的事

1. **不把共现当因果。** 模型提到 `postgres` 可能正在否决它。工具只报「出现过」，不报「依赖过」。
2. **不猜语义冲突。** 冲突只在内置槽位词表（`src/lexicon.json`）内成立；「要完整」vs「别啰嗦」，报告留空并说明原因。
3. **不假装看得见全部。** 模型权重里的偏好、被摘要改写的含义，都不在覆盖范围内，报告末尾单独列出。

## 为什么这么设计

这个工具不是凭空发明的形状，四个参考物各改了一处设计：

**W3C PROV-DM**（[PROV-DM, 2013 Recommendation](https://www.w3.org/TR/prov-dm/)）提供了一个现成的词汇表：`Entity` / `Activity` / `Agent`，以及 `wasGeneratedBy`、`used`、`wasInvalidatedBy`、`wasDerivedFrom`。记忆单元就是 Entity，轮次就是 Activity，模型是 SoftwareAgent；**压缩不是「删除」，是 `wasInvalidatedBy`**——这个词让「记忆什么时候失效」变成一等公民，而不是一个被忽略的副作用。`--prov` 直接导出这个模型，别人可以拿去做校验。
→ 影响：账本里的 `✕`、时间轴上的失效区间、PROV 导出。

**Anthropic《Effective context engineering for AI agents》**（[原文](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)）把上下文说成有限的「注意力预算」，并明确指出压缩是拿召回换空间：*"overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later"*。
→ 影响：不把「记忆库」当审计对象，把**上下文本身**当审计对象；新增「压缩保真度」——逐条核对被压掉的记忆，摘要里还找不找得到。

**LongMemEval**（[arXiv:2410.10813](https://arxiv.org/abs/2410.10813), ICLR 2025）把长期记忆拆成五项能力，其中两项正是 **knowledge updates** 和 **abstention**（该说不知道时说不知道）。
→ 影响：冲突裁决的存在，以及「没有证据就留空」的默认行为。工具宁可不给结论。

**Mem0**（[arXiv:2504.19413](https://arxiv.org/abs/2504.19413)）的写路径用 `ADD / UPDATE / DELETE / NOOP` 维护记忆，但它的 `DELETE` 是硬删除，历史随之消失。
→ 影响：不重做写路径，只做**写之后**的审计——写过什么、还剩什么、有没有被用、和谁矛盾。写得好不好是另一个问题；有没有留下痕迹，是这一层的问题。

## 数据来源

- **会话记录**：DSH v4 JSONL，`.zstd` 多帧容器（DSH 每次 flush 追加一帧，Node 只解第一帧，所以自带帧切分器）；也接受未压缩 `.jsonl`。
- **记忆库**：`-m/--memory` 指向 markdown 文件或目录，`-` 列表项成为记忆单元，标题成为来源路径。
- **派生证据**：`compaction/summary`（记忆被改写）、`compaction/prune` 与 `surfaceOp: replace`（记忆被抹掉）、`goal/change`（目标）、`skill` 工具调用（技能是否真被读过）。

## 结构

```
src/session.mjs   多帧 zstd 解压 → turns；压缩/裁剪 → eviction 区间；surfaceOp → 生命周期
src/claims.mjs    规则式断言抽取（槽位 + 取值 + 极性），决策词必须贴着术语
src/analyze.mjs   记忆单元、存活区间、三级证据、冲突裁决、压缩保真度、技能盘存
src/report.mjs    单文件 HTML（无外部依赖）
src/prov.mjs      W3C PROV-JSON 导出
src/cli.mjs       命令行
```

## 已知不足

- 关键词比对会**漏判**：摘要换了说法就查不到，所以「丢弃」应读作「查无实据」，不是「确定丢失」。
- 槽位词表只覆盖技术栈类决策。真实对话里绝大多数约束是自然语言，抓不到就是抓不到。
- 没有 token 级位置信息，因此无法回答「记忆在上下文里的位置是否影响它被使用」。
- 只测「说过/写过」，不测「因果」。因果需要干预实验，不是读日志能得到的。

## 测试

```bash
node --test
```

6 个测试。其中一个把开头那句「第 9 轮写入 SQLite，与第 3 轮 Postgres 冲突；此后 12 轮 Postgres 4 次、SQLite 0 次」重建为真实 transcript，逐字断言 `write-ignored`、`windowTurns=12`、`oldMentions=4`、`newMentions=0`。

## 许可

MIT
