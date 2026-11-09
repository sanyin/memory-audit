# 钩子：发之前的一句提醒

`memory-audit hook` 读 stdin 的 hook payload，只在**一个条件**下说话：

> 新消息和某条旧记忆词面重叠 ≥ 阈值，**并且**那条记忆已经被压缩/裁剪掉，不在上下文里了。

其余情况一律静默——包括"重复了但记忆还在"（那只是啰嗦，模型看得见），也包括"词面不重叠"（我们判断不了，就不打扰）。

## 为什么只报这一种

| 情况 | 说话吗 | 原因 |
| --- | --- | --- |
| 重复，且记忆已被压缩 | ✅ 报 | 模型真的忘了，你是在对空气喊 |
| 重复，但记忆还在上下文 | ❌ 沉默 | 模型看得见，提醒只会增加噪音 |
| 新内容，词面不重叠 | ❌ 沉默 | 判断不了的事情不装作知道 |
| 输入解析失败 / 会话读不到 | ❌ 沉默 | 钩子绝不能打断你的输入 |

## Claude Code

`~/.claude/settings.json` 里加：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node D:/Skills/memory-auditor/src/cli.mjs hook --hook-json"
          }
        ]
      }
    ]
  }
}
```

`--hook-json` 输出 Claude Code 的 `hookSpecificOutput` 契约；去掉它就退化成一行纯文本（stdout 会被当作附加上下文）。

会话位置默认取 payload 里的 `transcript_path`，取不到再退回"最近一次 DSH 会话"。也可以用 `--session <file>` 钉死。

## 其他 agent / 自己接

任何能在发送前执行命令、并把结果塞回上下文的地方都能接：

```bash
echo '{"prompt":"把 README 重写一下，中英文都要"}' \
  | node src/cli.mjs hook --session ~/.dsh/sessions/.../session.v4.jsonl.zstd
```

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 没说话，或者说了但不阻断（默认） |
| 2 | 只有加了 `--block` 且命中时才出现：按 Claude Code 约定即"阻断这次提交" |

## 性能

- 冷启动（解析整份会话，21MB）：约 0.9s
- 命中缓存：约 75ms

缓存键是会话文件的 `size + mtime`；因为活跃会话每轮都在变，缓存额外允许 30 秒的"近期过期"容忍，否则永远打不中。

## 目前不做的

- 不阻断（`--block` 是可选项，默认关）。词面比对在短句上必然误判，阻断的代价比漏报高。
- 不跨会话。只看当前会话的记忆。
- 不猜语义。"要完整"和"别啰嗦"的重叠，词面看不出来。
