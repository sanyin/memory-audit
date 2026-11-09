# memory-audit

把 agent 的记忆摊开：**写在第几轮、还在不在、有没有被用过、和谁打架**。

读会话记录 + 记忆库，输出一份可以逐条回溯到原始 `seq` 的账本，而不是一段总结。

```
记忆审计 · session-b3ea911a · 44 轮 · 21.4M 字符
  记忆单元 19（决策 0 / 要求 17 / 目标 2）
  冲突 0
  重复要求 0 组（压缩后重述 0 组） · 无强证据 8 条 · 压缩遗忘 9 条（2583 tokens）
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

# 发之前查一句：这句话说过吗？（适合做钩子）
node src/cli.mjs check --latest -t "把 README 再重写一版"
node src/cli.mjs repeats --latest                # 只列重复要求
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

## 重复：最便宜的记忆失败证据

「有没有被用过」需要推断，「是不是又说了第二遍」不需要——第二句话本身就是证据。

```bash
$ node src/cli.mjs repeats examples/demo-repeat.jsonl
重复要求 1 组（会话 session-demo-repeat，12 轮）：

  2×  第 3、12 轮  跨 9 轮 [压缩后重述]
      「把 README 重写一遍，中文为主，再加一份英文版。」

其中 1 组发生在压缩之后：摘要没接住，你只好又说了一遍。
```

`[压缩后重述]` 是这里最值钱的一类：第一次的要求在第 8 轮被压缩抹掉，主张里没有留下它，于是第 12 轮你又提了一次。**这是压缩失真的直接后果，不是你的记性问题。**

两种用法，精度不同，别混：

| 命令 | 判据 | 用途 |
| --- | --- | --- |
| `repeats` | 对称相似度 ≥ 0.62（近似原样） | 事后审计，高精度。「铁证」只在接近原样时成立 |
| `check --text` | 新消息的**覆盖率** ≥ 0.45（非对称） | 发之前预警，高召回。短消息不会被长记忆「解释掉」 |

`check` 会明确区分两种命中：

```bash
$ node src/cli.mjs check examples/demo-repeat.jsonl -t "把 README 重写一下，中英文都要"
这句话和第 3、12 轮的记忆重叠：

  覆盖 69%  部分重叠  · 第 3 轮  ·  已在第 8 轮被压缩，上下文里没有了
  「把 README 重写一遍，中文为主，再加一份英文版。」
  共用词：readme、重写一、英文

注意：命中的记忆已经不在上下文里了——重复它不会让模型"想起来"，只会再占一次预算。
```

### 当钩子用

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "node D:/Skills/memory-auditor/src/cli.mjs check --latest --stdin" }]
    }]
  }
}
```

`--fail-on-match` 会把强命中变成退出码 1（适合 CI 或需要阻断的钩子）；默认只提示不阻断。阈值 `--threshold 0.6` 更保守，`0.3` 更敏感。


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
src/repeat.mjs    重复检测（对称相似度聚类）与发前守卫（非对称覆盖率）
src/report.mjs    单文件 HTML（无外部依赖）
src/prov.mjs      W3C PROV-JSON 导出
src/cli.mjs       命令行：audit / check / repeats
```

## 已知不足

- 关键词比对会**漏判**：摘要换了说法就查不到，所以「丢弃」应读作「查无实据」，不是「确定丢失」。
- 槽位词表只覆盖技术栈类决策。真实对话里绝大多数约束是自然语言，抓不到就是抓不到。
- `repeats` 抓的是近似原样；换了说法的重问，它查不到——那是 `check` 的活，而 `check` 会因此更吵。
- 没有 token 级位置信息，因此无法回答「记忆在上下文里的位置是否影响它被使用」。
- 只测「说过/写过」，不测「因果」。因果需要干预实验，不是读日志能得到的。

## 测试

```bash
node --test
```

15 个测试，四组：会话解析（含多帧 zstd）、冲突裁决、压缩保真度、重复检测。其中两个是逐字断言：开头那句「第 9 轮写入 SQLite，与第 3 轮 Postgres 冲突；此后 12 轮 Postgres 4 次、SQLite 0 次」重建为真实 transcript，断言 `write-ignored`、`windowTurns=12`、`oldMentions=4`、`newMentions=0`；`examples/demo-repeat.jsonl` 断言「压缩后重述」的回合对 `[3, 12]` 与 `evictedAtTurn=8`。

## 许可

MIT
