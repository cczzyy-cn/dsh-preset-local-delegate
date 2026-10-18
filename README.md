# `local-delegate` 预设 —— 中文主说明

一句话：**把答案能被机器判定的子任务交给本地模型（0 API token），用确定性验证门把关，门不过就升级回 DeepSeek。**

它做的事只有一件：`cordis.patch.yml` 里那一长串插件是 DSH 自带 `standard` 预设的**逐字复制**，
唯一的增量是最后一行 `local-delegate.mjs`。

**三份文档的分工**（避免读到过期的那一份）：

| 文件 | 是什么 |
|---|---|
| **本文件 `README.md`** | **主说明**：契约、接口、判据、边界、运维。你现在读的这份就是权威用法说明。 |
| [`README.en.md`](README.en.md) | 英文完整版，保留**全部测量叙事与出处**（含历史沿革、每条结论怎么量出来的）。要证据去那里。 |
| [`NEXT-SESSION.md`](NEXT-SESSION.md) | 中文交接单：开发过程、未决项、指纹、踩过的坑。**要开工先读它最上面那一节。** |

---

> [!IMPORTANT]
> **改这个预设前必读：正常的信号会骗你。**
>
> 它是以 `file:` 目录依赖装进 `<profile>/node_modules/dsh-preset-local-delegate/` 的，而 pnpm 按 **manifest**
> 而不是内容来键控——所以改完 `local-delegate.mjs` 再"重新安装"，它会打印 *"Already up to date"*，
> 而 harness 跑的还是**旧模块**。2026-10-13 实测：这导致每次委派都被拒绝，报
> `route "strata/qwen3.8-flash-next-iq2_xs" is not allowed`，因为线上那份的 `LOCAL_MODEL` 还留着已删除的模型 id。
> **2026-10-15 换模型时又原样复现了一次**（IQ2_XS → IQ3_S）：新配置已经生效、引擎 `/v1/models` 只报 `iq3_s`，
> 而进程里那份 `LOCAL_MODEL` 还是 `iq2_xs` → 每次委派都被拒（`delegate_batch` 报 `stop=error`，0 token）。
> 所以"换了模型"必须走完 **sync-install + 重启 DSH** 两步，缺一不可。
>
> **每次改完都跑这两条，然后重启 DSH 本体：**
>
> ```bash
> node scripts/sync-install.mjs --check   # 退出码 1 = 线上副本是旧的
> node scripts/sync-install.mjs           # 复制，并逐文件报告改了什么
> ```
>
> **"我开了个新会话"不算重启**——模块实例是**每进程加载一次**（2026-10-02 实测）。
>
> ⚠️ **但「GUIDE 变了」≠「工具变了」**：提示词里的路由段落**每轮重新求值**，而**工具绑定停留在会话开始时的模块实例上**。
> 所以：**改 GUIDE 文本 → 下一轮就生效，不用重启；改工具行为 → 必须重启。** 判断"哪个模块在跑"永远用**行为探针**，不要看 GUIDE。

---

## 一、它解决什么问题

本地引擎（本机 Strata，`qwen3.8-flash-next-iq3_s`）免费但**不可靠**：同一个 prompt 发三次可能两次对、一次烧满 120 秒预算。
API token 贵但可靠。于是关键判断不是"这个任务看起来简单吗"，而是：

> **我能不能为这个答案写出一个确定性校验器？**

- 能 → 派给本地，用门验，省 token。
- 不能 → 留在 DeepSeek，不要派。

**为什么门槛是这个**：本地答案错了却**被静默接受**，就是一个正确性 bug；而错了**被门拒绝**，则既付了本地算力、又付了一轮 API——**比一开始就不委派更贵**。
所以"通过率"才是唯一真正重要的指标。

---

## 二、当前版本与状态（换机器/换模型后请逐项复核）

| 项 | 值 | 怎么确认 |
|---|---|---|
| 引擎 | Strata **0.1.44.1**（2026-10-15 从 0.1.43.1 升级；`strata.exe` 181.2 MB / `BD18453F65B4D03B`） | `engine/BUILD.json` 或引擎日志 `session is up (engine …)` |
| 模型 | **qwen3.8-flash-next-iq3_xxs**（约 3-bit 通用；2026-10-16 从 IQ3_S 换过来，内存少 6.9 GiB） | `curl http://127.0.0.1:8080/health` |
| 引擎窗口 / 图像 | `max_context` **262144**（模型训练长度；2026-10-15 曾降到 131072 省内存，同日按用户要求调回）、`images: true` | `curl http://127.0.0.1:8080/health` |
| 推理档位 | **`low`**（引擎 shared 默认）——**不要调回 `none`**（IQ3_XXS 上推理组 `none` 9/18、`low` 18/18） | `GET /settings`；而正确性证据见 §九 |
| DSH 路由 | `strata/qwen3.8-flash-next-iq3_xxs`，`contextWindow 262144` / `maxTokens 65536`（**两处必须与引擎的 `max_context` 对齐**；提示词硬上限 = 窗口 − maxTokens = 196608） | `list_subagent_models provider=strata` + profile patch |
| 内存余量 | 262144 下：IQ3_XXS 的 `arena_mib` = **40925 MiB（39.97 GiB）**、KV pinned 3.09 GiB、物理可用 **10.9 GB**、commit 余 14.2 GB；IQ3_S 同样上下文是 arena 47962 MiB、物理可用 **0.7 GB**、commit 余 5.4–8.1 GiB（换小量化是**唯一幅度够大的降内存手段**，省下的是 6.9 GiB）。**显存**：两者加载后都偏紧（IQ3_XXS 174 MiB、IQ3_S 73 MiB），引擎建议 `--vram-reserve-mib 1038`/`1139` | `Win32_PerfFormattedData_PerfOS_Memory` 的 CommittedBytes、引擎日志 `memory guard` / `VRAM free` |
| 自检 | **229 passed, 0 failed** | `node local-delegate.selftest.mjs` |
| 可靠上下文 | IQ2_XS 时代实测 **≤ 142K**（145K 不稳定、231K 必失败，见 §八）；**IQ3_S 上 257,742 token 三个深度 3/3 全对**（2026-10-15，只测了一个长度，待重扫） | 实测 |
| 模块指纹 | `local-delegate.mjs` `BAC60126866B4D9C`（123,872 B，2026-10-16 换 IQ3_XXS 后） | `Get-FileHash` / `sha256sum` |

---

## 三、安装与生效

```bash
node scripts/sync-install.mjs          # 或 npm run sync
node scripts/sync-install.mjs --check  # 只检查，不改
node local-delegate.selftest.mjs       # 229 个确定性用例
```

`sync-install` 把这些文件复制进 `$DSH_HOME/profiles/desktop/node_modules/dsh-preset-local-delegate/`：
`package.json` · `cordis.patch.yml` · `local-delegate.mjs` · `local-delegate.selftest.mjs` · `README.md` · `README.en.md`

两个容易踩的点：

1. **必须重启 DSH 本身**（工具行为的改动）；**未变的文件用硬链接同步**（共享 inode），所以 `--check` 报 `same` 时那是同一个 inode，不是巧合。
2. **改 GUIDE 文本不用重启**（见上面的 IMPORTANT）。两类改动**不同步生效**，别用一类去判断另一类。

---

## 四、注册了什么

| 注册项 | 说明 |
|---|---|
| `verify_task` | 单独执行一次校验（也用于**给带工具的子代理答案把关**） |
| `delegate_batch` | **派发 + 校验一体**：文本 / `files:` / 图像，**顺序**执行 |
| 一段 prompt 段落 | 顶层 agent 得到完整 **GUIDE**（**12,237 字符** ≈ 2,887 token）；**子代理得到 `CHILD_GUIDE`（625 字符 ≈ 153 token）** |

**为什么子代理也有一小段**：原来子代理是**什么都不给**的，前提是"子代理没有工具、不能委派"。一旦 `maxDepth` 提到 1 以上，这个前提就不成立了——
实测有子代理把 34 步里的 33 步耗在"幻觉工具 + 被深度拒绝的 `subagent`"之间循环。`CHILD_GUIDE` 只讲陷阱：**别去 `list_subagent_models` 找模型转包**、**真要调 `subagent` 就传 `run_in_background: false`**。
**LEADER MODE 那段只给顶层**——子代理的使命是执行，告诉它"决策指挥"正是那个跑飞的形状（自检从两个方向钉住这点）。

### 4.1 `delegate_batch` 任务字段

```text
{ tasks: [ { description, prompt, files?, images?, timeoutMs?, prove?, verify? } ], retries? }
```

| 字段 | 说明 |
|---|---|
| `prompt` | 内联的指令与输入。**子代理没有工具**，看不到的文件必须靠 `files:` 或自己贴进来 |
| `files` | **文本文件路径数组**。插件读文件并把**内容**内联进子代理提示（`<<< file: … >>>` 分块）；**字节不经过调用方**。总上限 `DSH_DELEGATE_FILE_CHARS`（默认 200,000 字符 ≈ 72K token）。坏路径 = 该任务 FAIL、**不重试**、不影响后续任务 |
| `images` | 图片路径数组（png/jpg/jpeg/webp/gif），由调用方读入并登记为 harness attachment。`all_of` 最适合验读图结果 |
| `timeoutMs` | **只覆盖本任务**的墙钟预算（默认取 `DSH_DELEGATE_TIMEOUT_MS` = 120 s） |
| `prove` | 派发前先证明门有力（见 §七）。**四类 kind 不要传** |
| `verify` | `{kind, expected?, field?, asserts?}`；**不传就是"未校验"**，不会被当成通过 |
| `retries` | 默认 **0**：FAIL 就是答案，由调用方升级或改问法（见 §十） |

**返回值**：每任务 `{id, ok, detail, output, attempts, stop, ms, spentMs, tokens?, outputFile?}`，外加批次 footer。

### 4.2 `verify_task` 字段

```text
{ kind, content? | contentFile?, expected?, field?, asserts?, prove? }
```

`contentFile` 是**反回贴**通道：让带工具的子代理把答案写进文件，你**按路径**验——答案就不必再经你的上下文一次（见 §九）。

### 4.3 输出与落盘

- 判决行只回显**有界切片**（`DSH_DELEGATE_OUTPUT_CHARS`，默认 500 字符）；**超过就整体落盘**，返回 `outputFile` + `bytes` + `sha256`。
- **FAIL 也落盘**——残缺答案就是"为什么失败"的证据。
- `outputFile` 存在的理由：子代理**没有工具**，它自己写不了那个文件，插件替它写。**读者是你**。

---

## 五、十六种 kind（全表）

| kind | 判什么 |
|---|---|
| `json_equals` | 与 `expected` 深度相等 |
| `json_order` | 按 `field` 排序后的对象数组 |
| `set_eq` | 集合相等（顺序与重复无关） |
| `count` | 数组长度 |
| `schema` | JSON Schema 子集：type / enum / required / properties / items / `additionalProperties` / `minLength`·`maxLength` / `pattern` / `minimum`·`maximum` |
| `exact` | 去首尾空白后的字符串相等 |
| `regex` | 正则匹配 |
| `contains` | **严格字面**子串 |
| `all_of` | `expected` 里每个 needle 都出现（数组，或 `"a\|b"` 字符串）；忽略大小写与标点。**对象形式 `{needles, wholeWord}` 可用** |
| `compile` | 答案能作为 JavaScript 解析 |
| `python_exec` | 抽出 `def` 块，用你的 `assert` 表达式运行（**传表达式**；行首 `assert` 也容忍） |
| `covers` | 每个 needle 都出现（可用 `field` 限制在某字段）——**判"漏了什么"**，needle 可机器派生 |
| `subset_of` | 答案里没有超出 `expected` 的元素；**缺项不算错**（反幻觉） |
| `union_eq` | 答案各组之并**恰好**等于 `expected`——分类可由全集单独判定 |
| `citation` | 每条 claim 带 `{file,line,quote}`，引文必须真的出现在那一行（±`tolerance`，可跨 `span` 行）；**claim 本身从不被评判** |
| `python_check` | 任意 Python 不变量，答案以 `answer` 到达 |

> **`all_of` 是「且」不是「或」**：`"正方形|矩形"` 永远无法满足。要「或」请用 `regex`。
> **`covers`/`all_of` 是单侧门**：它们只判"漏报"，**放过多报**。要"没有多余项"必须用 `set_eq`/`subset_of`。
> 2026-10-13 实测：同一份答案，`covers` 放过了一个多报的假名字，`set_eq` 抓住了它。

---

## 六、五种"不需要你先知道答案"的 kind

这是本预设最有价值的部分——它们让**摘要、审查、分类**这类原本无法验证的东西变得可验证：

| kind | 判什么 | 典型用途 |
|---|---|---|
| `covers` | 答案**漏了什么** | 摘要是否覆盖了所有要点（needles 可由机器从原文派生） |
| `subset_of` | 有没有**超出允许集合** | 反幻觉 |
| `union_eq` | 一个划分是否覆盖全集 | 分类（不用人事先规定哪项归哪类） |
| `citation` | **只验证据**：每条 claim 带 `{file,line,quote}`，引文必须真的出现在那一行 | 摘要、代码审查 |
| `python_check` | 任意 Python 不变量 | 任意写得出的断言 |

**优先用这五个**——它们免除了"得先算出正确答案才能委派"这个旧前提。

> **`citation` 的天花板，务必知道**：它证的是**引文为真**，不是**推论成立**。
> 实测 2026-10-13：5 条引用全部解析成功，其中一条 claim 并不由它引的那一行推出。
> **"有据可查"不等于"正确"。** 需要推论也要正确时，补一次便宜的确定性检查（例如用 `ConvertFrom-Json` 复核数字）。

---

## 七、`prove`：先证明门有力，再花钱

给任务加 `prove: true`，插件会从已知good答案派生若干**错误变体**，要求门**拒绝每一个**，同时**接受那个good答案**：

- 一个什么都不拒的门 = 装饰品；
- 一个连good答案都拒的门 = 更糟，每次委派都会失败并升级。

**四类 kind 无法自动证明**：`python_exec`、`python_check`、`regex`、`citation`。它们**既不能派生 positive，也没有结构变异算子**（门不看答案结构）。

> ⚠️ **对这四类不要传 `prove`**。传了会**拒绝执行**这个任务（不会浪费本地算力，但浪费一轮），即使你自带 `prove.positive` 也一样——
> 它只让插件顺带检查"positive 半边"。请**自己手工双向验**：门必须**接受**一个good答案、**拒绝**一个故意写错的。

> 曾经的坑：`citation` 的 positive 恰好是 JSON，于是通用算子（改数字、删字段）照样命中，报出 `accepts 2/6 wrong answers`——**对着一个完好的门报假警报**。现在这四类已从结构变异中排除。

---

## 八、领导模式（本预设推荐的使用方式）

**你决策、指挥、监视；读原料不一定是你的活。**

1. **拆**成"每一步都以一个可机器判定的结论收尾"的子任务；
2. **先写判据再派**——写得出判据，才说明你理解了这一步；**如果写判据比做这一步还贵，那就自己做**；
3. **派**：纯文本走 `delegate_batch`；要读文件、看图、用工具的走 `subagent`；
4. **判决和载荷一起读**——PASS 只覆盖你判据问过的部分；
5. **FAIL 就改点什么**（拆小 / 换问法 / 自己做），**不要原样重发**。

**三件不外放**：判据本身、跨文件因果与多步推理、用户要读的那句话。

**红线**：只委派"**能被机器检查的步骤**"，绝不委派"**一连串动作**"。点击没有确定性判据——点错是静默的。**感知可以委派，能动性不行。**

---

## 九、Token 经济学（实测，不是估算）

### 9.1 一次委派花多少（固定前缀）

**一次委派是一次全新的请求，父会话的对话不会进去。** 进去的是固定前缀 + 你放进 `prompt` / `files:` 的东西：

| 形状 | 固定 prompt 前缀 | 边际 |
|---|---:|---|
| `delegate_batch`（工具被剥离） | **≈ 2.4K token** | **+0.28 token / 字符**（实测：+1,190 字符 = +338 token，≈3.5 字符/token） |
| `subagent`（继承工具） | **≈ 15.3K token** | 几乎全是工具 schema；**同一子运行的后续步骤复用前缀**（实测 step2 `reused 15,327`） |

### 9.2 批次账本（本版新增）

每个任务与批次 footer 都会报**本地实际处理的 token**，取自引擎自己的 `GET /metrics`：

```text
— 2/2 PASS · 8.1 s of local compute · 10,252 local tokens
  (9,937 prompt: 9,937 read + 0 reused; 315 generated) · 0 API tokens
```

`SubagentResult` **没有** usage 字段（运行构建只声明 `output`/`structured`/`diagnostic`/`stopReason`），所以账本靠引擎计数器的**前后差**。
**引擎没开 `/metrics`、或中途重启（计数变少）时，这一行直接不出现**——不给一个它兜不住的 0。

### 9.3 一次真实项目分析的节省率

对 `dsh-session-sync`（35 文件 / 478 KB）做分析，**源码内容全部由本地读**：

| 项 | 值 |
|---|---|
| 本地处理 | **111,684 prompt token**（66,445 新预填，其中**项目内容 47,752 token = 132,793 字节 @2.78 字符/token**）+ 3,344 生成 |
| 墙钟 / API token | **24.9 s / 0** |
| 调用方（DeepSeek）侧增长 | **≈ 1,850 token**（派发 + 判决 + 读回，按字符估算） |
| **节省率** | 同这份分析 **≈96%**；整个项目 **≈98%** |

**节省会复利**：调用方读进来的 token 会留在它的上下文里、之后每轮都被重新处理；而一次委派只付一次。

### 9.4 另外三笔账

- **回贴税**：`subagent` 的答案**必须回贴进 `verify_task`** 才能判，于是它**两次**穿过你的上下文。→ 要紧凑答案，或让子代理**写进文件**、你用 `contentFile` 按路径验。
- **别自己贴文件**：`files:` 就是为这件事存在的。你自己把文件内容打进 `prompt`，那些字节**你也要付一遍**。
- **省的是钱和上下文，不是时间**：本地这次花 24.9 s，还有 120 s 预算与"子代理绕圈"的风险。

### 9.5 前缀缓存的真相（2026-10-13 实测，更正旧说法）

| 观察 | 数字 |
|---|---|
| 两个**逐字节相同**的 prompt 背靠背 | **两次都 `reused=0`** |
| 两个共享 ~2.3K 前缀、只有尾巴不同 | 同样 `reused=0` |
| **同一个子运行**的第 2、3 步 | `reused 15,649` / `20,514` ← 运行内复用成立 |

机制：`/metrics` 报 `conversation_cache.enabled: false`、`budget_mib: 0`，而 `min_free_mib: 2560` 对 `vram_free_mib: 225`
—— **跨会话缓存被显存饿死**，不是预设配错。**推论**：每个同批任务都要付完整固定前缀（≈2.4K ≈ 1.2 s 预填），所以**把小任务合并成更大的任务比拆开更省**。

---

## 十、关键约束与红线

| 约束 | 值 / 做法 |
|---|---|
| 单次墙钟预算 | `DSH_DELEGATE_TIMEOUT_MS`，默认 **120 s**（可用任务级 `timeoutMs` 覆盖）；超时即 `aborted`、**不重试** |
| 重试 | 默认 **0**——10 次同形状观察里盲重发从未救回（且引擎**非确定性**，重发是**另一个样本**，不是重放） |
| 输入规模 | `delegate_batch` 建议 **< 40 行 / 4K 字符**内联；更大的任务**用 `files:` 或切开**（实测 47 行抽取会退化成逐字复读） |
| 输出上限 | `maxTokens 131072`（profile）/ `DSH_LOCAL_MAX_TOKENS` 4096（单次生成）——形状是**输入可以很大、输出要小** |
| 容量**不可查询** | `list_subagent_models` **只给名字**。真实窗口看引擎 `GET /health` 的 `max_context`；**引擎从不截断**，`prompt + maxTokens` 超窗口直接 400 `CONTEXT_WINDOW_EXCEEDED` |
| 可靠上下文 | **≤ 142K token**；越界后不是"找不到"，而是**指令跟随整体崩塌**（还会撞满 max_tokens）。**委派 prompt 控制在 128K 以内** |
| 图像 | `images: ["<绝对路径>"]`；640×480 ≈ 330 token、1280×960 ≈ 1002。**引擎只读不画**，没给它的它看不见 |
| 语言 | 本地模型中英混杂（约 60% 中文），中间结果无妨；**最终文案归 DeepSeek** |

**唯一红线**：**只委派能被机器检查的步骤，绝不委派一连串动作。**

> （2026-10-13 更正）旧版这里还有一条"读原料型任务必须走 `subagent`，因为 `delegate_batch` 要内联、约等于 2× 基线的倒亏"。
> **`files:` 已经把这条修好了**：现在把路径交给 `delegate_batch`，字节由插件读、**不经过你的上下文**。
> 只有"需要工具在子代理侧**探索**（glob/多次试读/看图）"时，才仍然该走 `subagent`。

---

## 十一、门配对的七个坑（实测，全都踩过）

1. **`subset_of` 不保证完整**——空数组也满足它。"没有多余项" ≠ "没有遗漏"。
2. **`set_eq` 不管重复**——要防重复必须用 `python_check`（`len(a) == len(set(a))`）。
3. **`all_of` 是「且」不是「或」**——要「或」请用 `regex`。
4. **`regex` 不支持 `(?i)`**（JS 风格）→ `Invalid group`。
5. **`regex`/`python_exec`/`python_check`/`citation` 的 `prove` 必须自带 `prove.positive`**，否则报 `no positive example`。
6. **`python_check` 根本无法 `prove`**（无结构变异算子）→ 只能**手工验证**；插件会明说这是 expected、不是缺陷。
7. **`covers` 的 needles 要宽容近义词**——模型写「**售价** 899 元」而 needle 是「价格」就会误判。

> 另外：1、2、6 这几种门**插件会主动拒绝执行**（`gate has no power`），**不会浪费一次委派**——这正是 `prove` 的价值，不要因为被拒就去掉它。

---

## 十二、回归门与运维工具

每次改完都跑（全绿才算完）：

```powershell
cd <此仓库>
node --check local-delegate.mjs
node local-delegate.selftest.mjs                     # 期望 229 passed, 0 failed
node scripts/sync-install.mjs --check                # 期望 up to date
cd ..
python tools\build-local-delegate-preset.py --check  # cordis.patch.yml 是否与源码一致
python tools\validate-preset-bundle.py dsh-preset-local-delegate
python tools\check-profile-roster.py                 # 期望 OK: 5 presets
node   tools\session-headers.mjs --preset hybrid-router --blank   # 期望 0
```

| 工具 | 用途 |
|---|---|
| `scripts/sync-install.mjs` | 同步进 profile 的 pnpm 副本（`--check` 只报） |
| `scripts/subagent-trace.mjs` | 读任意会话/子代理的 zstd 记录，打印时间线（`--last`/`--watch`/`--raw`/`--json`） |
| `tools/session-route-policy.mjs` | **换模型后必跑**：列出每个主会话的 durable 路由策略（`allows-local` / `dead-route` / `no-local-route`）。被钉在已删除模型上的会话，`subagent` 会被拒（`delegate_batch` 不受影响） |
| `tools/session-headers.mjs` | 逐会话列出 `agentPreset`；`--preset X --blank` 找"被删预置卡住的空白会话" |
| `tools/asar-read.py` | 直读运行中的 `app.asar`（`--find`/`--grep`/`--cat`）——**涉及 harness 内部的结论必须在这里取证** |

> ⚠️ **一次性的自检崩溃**（观测过、未复现）：一条命令里连跑多个 node/python 时，自检曾以 `exit=-1073740791`（`0xC0000409`）
> 中断。**先原样复跑一次**，不要当成预设的缺陷。

---

## 十三、文件清单

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | **生成物**：`standard` 预设逐字 + 一行。由 `tools/build-local-delegate-preset.py` 生成，别手改 |
| `local-delegate.mjs` | 唯一增量：16 个校验器、`delegate_batch`（文本 / `files` / 图像 / 账本）、GUIDE 与 CHILD_GUIDE |
| `local-delegate.selftest.mjs` | 229 个确定性用例（每条都钉一个行为或一个曾经的缺陷） |
| `scripts/` | `sync-install.mjs`、`subagent-trace.mjs` 等（**不在安装副本白名单里**，从源码目录用） |
| `README.md` | **中文主说明**（本文件） |
| `README.en.md` | 英文完整版（含全部测量出处） |
| `NEXT-SESSION.md` | 中文交接单（开发过程、未决项、指纹） |

---

## 十四、什么时候**不要**用它

- 多步推理、方案设计、跨文件因果分析——**无法确定性验证**，留 DeepSeek。
- 用户会读的最终文案——留 DeepSeek。
- 日志/配置的**查询**类任务——`grep`/`jq` 更便宜，委派收益很小甚至为负。
- 一次性、单件的任务——写 checker 的成本落在 DeepSeek 上，只有**成批同形状**才摊得薄。
- **需要"忠实复现长串字符"的任务**（逐字抄 200 字符以上）：实测会退化成循环并烧满预算。

**甜点区**：遍历型任务（读 N 个文件 → 出 N 条结构化结果）——同时满足"省得多"（父模型本需全量读）与"可自动验证"（`covers` 不需要知道答案）。

---

## 附：把「领导模式」跑起来的五句话

1. 拆到"每步一个可机器判定的结论"。
2. 先写判据，再派；判据比任务贵就自己做。
3. 文本进 `prompt`，文件进 `files:`，图片进 `images:`，要工具走 `subagent`。
4. 读判决**和**载荷（长答案看 `outputFile`）。
5. FAIL 就改点什么，别重发。
