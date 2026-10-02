# dsh-preset-local-delegate —— `local-delegate` 预设（中文精简版）

> 这份是**精简中文版**，完整英文原版见 [README.md](README.md)。两者都由同一个模块驱动，但下面这份**包含本机最近一次实测的结论**，部分内容比英文版更新。

一句话：**把答案能被机器判定的子任务交给本地模型（0 API token），用确定性验证门把关，门不过就升级回 DeepSeek。**

它做的事只有一件。`cordis.patch.yml` 里那一长串插件是 DSH 自带 `standard` 预设的**逐字复制**，唯一的增量是最后一行 `local-delegate.mjs`。

---

## 一、它解决什么问题

本地引擎（本机 Strata，`qwen3.8-flash-next-coder-iq1_m`）免费但**不可靠**：同一个 prompt 发三次可能两次对、一次烧满 120 秒预算。API token 贵但可靠。

于是关键判断不是"这个任务看起来简单吗"，而是：

> **我能不能为这个答案写出一个确定性校验器？**

- 能 → 派给本地，用门验，省 token。
- 不能 → 留在 DeepSeek，不要派。

**为什么门槛是这个**：本地答案错了却**被静默接受**，就是一个正确性 bug；而错了**被门拒绝**，则既付了本地算力、又付了一轮 API——**比一开始就不委派更贵**。所以"通过率"是唯一真正重要的指标。

---

## 二、安装与生效

```bash
node scripts/sync-install.mjs          # 或 npm run sync
node scripts/sync-install.mjs --check  # 只检查，不改
```

它把 5 个文件复制进 `$DSH_HOME/profiles/desktop/node_modules/dsh-preset-local-delegate/`：
`package.json` · `cordis.patch.yml` · `local-delegate.mjs` · `local-delegate.selftest.mjs` · `README.md`

两个容易踩的点：

1. **必须重启 DSH 本身**。preset 模块**一个进程只加载一次**——"新开会话"不够。sync 工具自己也会打印这句提醒。
2. **未变的文件用硬链接同步**（共享 inode），所以 `--check` 报 `same` 时那是同一个 inode，不是巧合；改了工作区一侧会同时改安装副本一侧。

跑测试：

```bash
node local-delegate.selftest.mjs       # 195 个确定性用例
```

---

## 三、注册了什么

| 注册项 | 说明 |
|---|---|
| `verify_task` | 单独执行一次校验 |
| `delegate_batch` | **派发 + 校验一体**：文本与图像，顺序执行 |
| 一段 prompt 段落 | 顶层 agent 得到完整 **GUIDE**（9,778 字符 ≈ 2,391 tokens）；**子代理得到 `CHILD_GUIDE`（625 字符 ≈ 153 tokens）**，比例约 **15.6 : 1** |

**为什么子代理也有一小段**：原来子代理是**什么都不给**的，前提是"子代理没有工具、不能委派"。一旦 `maxDepth` 提到 1 以上，这个前提就不成立了——实测有子代理把 34 步里的 33 步耗在"幻觉工具 + 被深度拒绝的 `subagent`"之间循环。`CHILD_GUIDE` 只讲两个陷阱：**别去 `list_subagent_models` 找模型转包**、**真要调 `subagent` 就传 `run_in_background: false`**。

---

## 四、五种"不需要你知道答案"的 kind

这是本预设最有价值的部分——它们让**摘要、审查、分类**这类原本无法验证的东西变得可验证：

| kind | 判什么 | 典型用途 |
|---|---|---|
| `covers` | 答案**漏了什么** | 摘要是否覆盖了所有要点（needles 可由机器从 expected 推出） |
| `subset_of` | 有没有**超出允许集合** | 反幻觉 |
| `union_eq` | 一个划分是否覆盖全集 | 分类（不用人事先规定哪项归哪类） |
| `citation` | **只验证据**：每条 claim 带 `{file,line,quote}`，引文必须真的出现在那一行 | 摘要、代码审查 |
| `python_check` | 任意 Python 不变量，答案以 `answer` 到达 | 任意可写出的断言 |

**优先用这五个**——它们免除了"得先算出正确答案才能委派"这个旧前提。

---

## 五、`prove`：先证明门有力，再花钱

给任务加 `prove: true`，插件会从已知good答案派生若干**错误变体**，要求门**拒绝每一个**，同时**接受那个good答案**：

- 一个什么都不拒的门 = 装饰品；
- 一个连good答案都拒的门 = 更糟，每次委派都会失败并升级。

**四类 kind 无法自动证明**：`python_exec`、`python_check`、`regex`、`citation`。它们**既不能派生 positive，也没有结构变异算子**（门不看答案的结构）。对它们 `prove` 会明确回一句"预期之内、不是缺陷"，请**自己手工双向验**：门必须**接受**一个good答案、**拒绝**一个故意写错的。

> 曾经的坑：`citation` 的 positive 恰好是 JSON，于是通用算子（改数字、删字段）照样命中，报出 `accepts 2/6 wrong answers`——**对着一个完好的门报假警报**。现在这四类已从结构变异中排除。

---

## 六、实测数据（本机）

| 场景 | 结果 |
|---|---|
| 9 个文件、366 KB → 各写一行职责摘要 | **9/9 准确**，24.5 s，父模型侧省约 **85%** |
| 同一 prompt（版本号排序）连发 3 次 | **2 次正确 + 1 次烧满 120 s** |
| 一次超时的内部构成 | 34 步 / 33 次工具调用，在幻觉工具与 `subagent` 之间循环 |
| 全项目文本一遍（467 文件 / 6.5 MB / 约 163 万 tokens） | 约 **30 个批次**；浅遍历省 **21 万**，深遍历省 **160 万** tokens |

**甜点区**：遍历型任务（读 N 个文件 → 出 N 条结构化结果）——同时满足"省得多"（父模型本需全量读）与"可自动验证"（`covers` 不需要知道答案）。

**死亡区**：字符级计数（实测答错）、语义版本排序（约 1/3 概率烧满预算）、以及任何**强制结构化输出**压力下的任务（会陷入工具调用循环）。

---

## 七、关键约束

| 约束 | 值 / 做法 |
|---|---|
| 单次墙钟预算 | `DSH_DELEGATE_TIMEOUT_MS`，默认 **120 s**；超时即 `aborted`，**不重试** |
| 重试 | 默认 **0**——10 次同形状观察里盲重发从未救回（且引擎非确定性，重发是**另一个样本**，不是重放） |
| 输入规模 | 建议 **< 40 行 / 4K 字符**；更大的任务**切开**（实测 47 行抽取会退化成逐字复读） |
| 容量**不可查询** | `list_subagent_models` **只给名字**，没有 context/输出上限/模态。真实窗口去看引擎 `GET /health` 的 `max_context`；provider model row 的 `contextWindow`/`maxTokens` 决定 harness 的认知。**引擎从不截断**：`prompt + maxTokens` 超窗口直接 400 `CONTEXT_WINDOW_EXCEEDED` |
| 嵌套 | 由宿主 `maxDepth` 决定（本机为 2）。`subagent` **默认后台**：不传 `run_in_background: false` 就只返回一个 id，结果稍后以消息到达 |
| 图像 | 引擎是多模态的；任务是 `images: ["<绝对路径>"]`。用 `all_of` 验读图结果。**引擎只读不画**，没给它的它看不见 |
| 语言 | 本地模型中英混杂（约 60% 中文），中间结果无妨；**最终文案归 DeepSeek** |

**两条红线**：

1. **读原料型任务必须走 `subagent`，不能走 `delegate_batch`。** `delegate_batch` 的输入必须内联，父模型会先读一遍原料、再生成一遍作为 prompt，约等于 **2× 基线的倒亏**。
2. **只委派"能被机器检查的步骤"，绝不委派"一连串动作"。** 点击没有确定性判据——点错是静默的。**感知可以委派，能动性不行。**

---

## 八、文件清单

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | **生成物**：`standard` 预设逐字 + 一行。由 `tools/build-local-delegate-preset.py` 生成，别手改 |
| `local-delegate.mjs` | 唯一增量：校验器、`delegate_batch`、GUIDE / CHILD_GUIDE |
| `local-delegate.selftest.mjs` | 195 个确定性用例 |
| `scripts/subagent-trace.mjs` | 读任意会话/子代理的 zstd 记录，打印时间线（`--last` / `--watch` / `--raw` / `--json`） |
| `scripts/sync-install.mjs` | 同步进 profile 的 pnpm 副本 |
| `NEXT-SESSION.md` | 中文交接单（开发过程与未决项） |
| `README.md` | 完整英文原版（含全部测量出处） |

**注意**：`scripts/` **不在** `sync-install.mjs` 的 `FILES` 白名单里，所以 `subagent-trace.mjs` 不会装进安装副本——从源码目录用它即可。

---

## 九、什么时候**不要**用它

- 多步推理、方案设计、跨文件因果分析——**无法确定性验证**，留 DeepSeek。
- 用户会读的最终文案——留 DeepSeek。
- 日志/配置的**查询**类任务——`grep`/`jq` 更便宜，委派收益很小甚至为负。
- 一次性、单件的任务——写 checker 的成本落在 DeepSeek 上，只有**成批同形状**才摊得薄。
