# 新会话交接单 — `local-delegate` 预设的收尾验证

> 给**下一个在 `Local Delegate` 预置上开会话的 agent（或人）**。
> 本文件自包含：不需要本轮对话的上下文。
> **当前状态（2026-10-02 晚，见 0.6 – 0.12）**：**A/B/C/D/E/F/G 全部关闭**并留了实测（D 的
> roster 行已在 GUI 里目视确认，见 0.9）；H（图片子任务会去戳 `subagent`，最坏撞满 120 s 预算）是
> **新开的观察项**，不是待修项。**§5 已执行**（hybrid 从 profile 清单里摘掉，见 0.10，**已在重启后的进程里得到证实**，见 0.12）；
> **新发现 I 已处置**（三份拷贝先存档后删除，见 0.11）。
> **0.12（重启后的进程级验收）抓到并修好一个真缺陷**：一个空白会话头部记着已删预置，导致「新会话」整条路失败。
> **唯一剩下的人工动作**：点一次「新会话」看页面是否正常打开（本轮鼠标停在安全中止位，没有绕过 fail-safe）。
> 两条最贵的教训写在 0.6：**模块实例是每进程加载一次（"开新会话"不够，要重启 DSH）**，以及
> **判断哪个模块在跑要看行为（`attempts`）而不是看 GUIDE**。
> **0.8（本轮，跑在 hybrid 预设上）**：第 6 节回归门全绿；D 的磁盘侧在**四份** hybrid 拷贝上确认；hybrid 自身量到「同版本号、两份不同代码」。
> **0.9（最新一轮，跑在 Local Delegate 上）**：行为探针确认新模块后，A/B/G 端到端复现、第 6 节回归门再次全绿，
> **D 的 roster 行已在 GUI 里目视确认 → D 关闭**。剩下两个只有用户能拍板的项（§5、新发现 I）仍未动。
> **0.10（同一轮，用户拍板后）**：**§5 已执行** —— hybrid 从 profile 清单里摘掉（三份文件改动 + 备份 + 机检全过），
> **待重启 DSH 生效**；新发现 I 降级为可选清理。**roster 已在文件级证明**（新工具 `tools/check-profile-roster.py`，
> 过 4 个变异测试）：重启后应是 `standard / ptc / minimal / cordis / local-delegate`，**没有** `hybrid-router`。
> **0.11（同一轮，用户第二个决定）**：新发现 I 已处置 —— 三份 hybrid 拷贝**先存档、后删除**（存档里有 `.git`
> 和**未提交的增强版 router**，删前发现它们只存在于这三份里）；标出两处**不是** bundle 拷贝、特意没删的路径。
> **0.12（目标轮，重启已发生）**：进程级验收抓到**真缺陷**并修好 —— 空白会话头部记着已删预置 → 「新会话」必然失败；
> 新增两个工具（`session-headers.mjs` / `session-set-preset.mjs`）。hybrid 摘除**在运行进程里得到证实**。

---

## 0. 为什么必须新会话（前提被误改过一次，这里改回并留证）

**结论：必须开新会话（或重启 DSH）。改好的模块不会在当前会话里生效，后续轮次也不会。**

经过留档，因为"为什么会误判"本身就是这个预设最容易踩的坑：

1. **原文**："DSH 在会话**创建时**加载一次插件模块。所以改完代码后仍在跑旧模块的会话，是一个会主动
   骗人的环境。" —— **这条是对的**。
2. **上一轮的误判（已撤销）**：我观察到本会话第二轮的**系统提示里出现了我上一轮才写进模块的句子**
   （预算那条、语义版本反例、greedy 更正），就推断"模块跨 turn 会重新加载"，并据此写下
   "改完 sync 后结束本轮即可，不必新会话"。**这个推断是错的**，被本轮一次直接实验推翻：
   - 安装副本已是修好的版本（当时 `local-delegate.mjs` SHA256(16) = `5ACBD57AED45B66A`，与源码一致；
     本轮又加了 footer 成本归属，当前值见下表）；
   - 而本轮派发**仍然**报那个上一轮就已被删除的 `deny` 错误：
     `tools.restrict() names unknown global tools "subagent", …`（每个任务 ~5 ms、`attempts=3`）。
3. **实际发生的是两件不同的事**：提示词里的路由 GUIDE 段落**每轮重新求值**（所以它读得到新文件），
   而**已注册的工具仍绑定在会话开始时的那个模块实例上**。**GUIDE 变了 ≠ 工具变了。**
   上一轮的错，就是拿前者当后者的证据——本会话也因此白费了两轮（每次都撞同一个 `deny` 错误）。

**操作规则**：改完模块 → `node scripts/sync-install.mjs` → **开新会话（或重启 DSH）**。
不要用"系统提示里的 GUIDE 变了"判断模块是否生效；也不要指望同一会话的后续轮次会好。
自检（`node local-delegate.selftest.mjs`）与运行时是两回事：自检在磁盘上跑，所以它一直是对的。

- 源目录（改这里，不要改安装副本）：`C:\Users\14339\Desktop\git\Strata\dsh-preset-local-delegate\`
- 安装副本（会话真正加载的）：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-preset-local-delegate\`
- 同步：`node scripts/sync-install.mjs`（`--check` 只报告，过期时 exit 1）

**交接时的 revision 指纹**（SHA256 前 16 位，源与安装副本当时一致）：
（**已更新** —— `B7469579B618C45D` / `1F08378804D3DA7A` / `B4522A04390C2AFC` 是最老的；
`AFB14936C85935FB` 是"有预算**也有** `deny`"的中间版本，那个版本会让**每一次委派都失败**，
见到它必须当成坏的。）

| 文件 | SHA256(16) |
|---|---|
| `local-delegate.mjs` | `60B3D4DE55512D8A`（本轮**未改**） |
| `local-delegate.selftest.mjs` | `408E4DB99467824A`（本轮**未改**） |
| `README.md` | `12CC6A0E9039EEB3`（0.12 写回后，已 sync；此前依次为 `FC789979A93DCB31`、`6A82F878A340829E`、`2B3EF98E1962F694`、`BCF69D15203867E0`、`72E8F0EB55AFB394`） |
| `scripts/sync-install.mjs` | `D225D51552202305`（收尾提示改成"重启 DSH 本身"） |
| `tools/asar-read.py`（仓库根，新） | `CD36F311512831D3` — 直读 `app.asar` 的 `--find/--grep/--cat` |
| `tools/session-dump.mjs`（仓库根，新） | `B4BB192DBA302D17` — 逐帧解开 `session.v4.jsonl.zstd` |
| `tools/check-profile-roster.py`（仓库根，新，0.10） | `31682D08E82EA31D`（8,807 B）— 从文件 + 运行构建合成 patch 栈，求出 roster 与有效默认预置 |
| `tools/session-headers.mjs`（仓库根，新，0.12） | `328EB422CCD8D8DE`（4,411 B）— 逐会话只解第一帧，列出 `agentPreset`/空白/来源；`--preset X --blank` 找"被删预置卡住的空白会话" |
| `tools/session-set-preset.mjs`（仓库根，新，0.12） | `6989D7FF206C8DBB`（4,771 B）— 默认 dry-run；只重写会话的**第 0 帧**改 `agentPreset`，其余帧逐字节不动，自带备份与逐帧复核 |
| `dsh-preset-hybrid.removed-2026-10-02.zip`（仓库根，新，0.11） | `F76653AF06EEA90B`（377,315 B）— 被删三份 hybrid 拷贝的归档；**也是 0.10 正对照变异的夹具**，别删 |

源与安装副本逐字节一致（`cordis.patch.yml` `E52A9FEB360C4D38`、`package.json` `3CE96894B05B9EBC`）。

自检套件：`node local-delegate.selftest.mjs` → **190 passed, 0 failed**。

---

## 0.5 上一轮的收尾结果（模块已是新版的那次会话）

回归门全绿：`190 passed, 0 failed`、`sync-install --check` up to date、`build --check` up to date、
两个 bundle 的 `validate-preset-bundle` 均 valid。`README.md` 已按第 8 节写回；**模块也改了**
（子运行墙钟预算 + 两处被实测推翻的 GUIDE 更正；`deny` 名单曾短暂加入、已删除），源与安装副本已
`sync-install` 对齐，**必须开新会话才生效**（见第 0 节）。

> ⚠️ **注意**：写这份记录的最后那一轮，模块已经换过、会话也换过了，`deny` 那个坏绑定**已经不在**。
> 若再见到 `tools.restrict() names unknown global tools`，说明又回到坏版本上（见第 1 节）。

> ⚠️ **重启 DSH 之后的第一件事**（G）：跑一次**图片**委派，确认 `images:` 全链路真的通了
> （夹具已生成在 `%TEMP%\vision-fixtures\`，5 张：`img-plain.png` / `img-small.png` / `img-large.png` /
> `img-multi.png` / `img-photo.jpg`）：
> ```
> delegate_batch { tasks: [ { description: "ocr", prompt: "Read the text. Two lines, nothing else.",
>   images: ["C:\\Users\\14339\\AppData\\Local\\Temp\\vision-fixtures\\img-plain.png"],
>   verify: { kind: "all_of", expected: ["MEN WALK ON MOON", "SAMPLE 42 DELTA"] } } ] }
> ```
> 期望 `PASS` 且 `raw` 回显里有那两行字。若仍报 `Unsupported or malformed image data.`，说明进程里还是旧
> 模块实例（见第 0 / 0.6 节）——**"新会话"不够，要把 DSH 整个退掉重开**。

| 任务 | 状态 | 结论 |
|---|---|---|
| A 子代理 prompt token | ✅ 已关闭 | 实测 `prompt 1963 tokens = 0 reused + 1963 read`，落在预测的 1,800–2,000 内。README 已写实测值 |
| B 未完成运行不算答案 | ✅ 已关闭 | 600 项数组 + 只看前两项的 `covers` 闸门 → 残答案**确实满足闸门**，仍判 `FAIL … stop=max-tokens (42460 ms)`、footer `0/1 PASS`。13,208 B 残答案落盘，两个 needle 都在里面 |
| C retries 默认值 | ✅ **已关闭：默认改为 0** | 10 次同形状观察（7 次反转 hex 串 + 3 次算术）全部 `retried > 0` 且 **`recovered == 0`**，达到第 4 节的 ≥5 门槛。另有三条支持：重试可能撞满 **120 s 预算**（实测两次）；"改问法/拆输入"只有调用方做得到，插件原样重发正是 README 反对的做法；预设契约是 FAIL→升级 DeepSeek，本地静默重买是反的。**旧的"贪心=同一份采购"理由已被证伪**（引擎逐字节不确定）。诚实边界也写进 README：10 次全是"模型做不出的任务"，它证明的是"重发救不了没希望的任务" |
| D hybrid roster 标签 | ✅ 已修，**待重启确认** | 标签只写进了 `bundles/` 副本，**从未同步到真正被加载的 `node_modules/` 副本**（见第 5 节的更正） |
| E 新缺陷：子代理跑飞 | ✅ 已修，且**已在真实派发里端到端验证** | 子代理 `turn/end` 在 **+120.018 s** 以 `{"kind":"aborted","reason":{"kind":"parent"}}` 结束（预算开火后 18 ms 生效）。`deny` 已回退。自检 190 passed、已 sync |
| F 批次成本归属 | ✅ 已修 | footer 原先只累加**最后一次尝试**的 `ms`（真实 253 s 被印成 `240.1 s`）。现在按行累加 `spentMs`（全部尝试），自检用"第一次故意慢 60 ms"的做法钉住差异，变异后该断言单独失败 |
| G **`images:` 全链路是坏的** | ✅ 根因已定位并修复，**待新会话确认** | 派发图片**在到达引擎之前**就失败：`Unsupported or malformed image data.`、`0.0 s of local compute`。根因：运行构建声明 `SaveImageAttachment { data: Uint8Array; … }`，存储层用 `sharp` 解码**原始字节**；而模块送的是 `buf.toString('base64')`——那是 RPC **wire** 形状，harness 自己的适配器正是 `saveInput(){ return { data: decodeBase64(image.data), … } }`。**自检还在钉住这个 bug**（一条断言 `data === …base64`、一条断言 `typeof data === 'string'`），所以 190 条全绿却完全跑不通。两条断言已反转为"必须是字节"并引用构建声明，变异回 base64 会让**恰好这 2 条**失败 |

### 第 4 节的前提被证伪：引擎不是逐字节确定的

原来"重试 = 同一份采购买两次"的说法**不成立**。同一个 prompt 的三次尝试，生成 token 数为
86/50/44、49/48/54、55/56/79、321/46/57 —— **每次答案都不一样**，引擎在紧挨着的两次请求之间都
不逐字节确定（推测解码的 draft 接受 + 连续批处理都可能贡献这一点，未定论）。所以重试是"**不同的**
采购"，只是价格一样。

同时"用语义版本排序当确定性失败探针"这条**已失效**：本次两个语义版本排序任务**首次尝试就正确**
（`["3.10","2.7","3.9","2.11"]` → `["2.7","2.11","3.9","3.10"]`），拿它当探针只会 0 次重试。
真正能稳定失败的是**反转 20–48 位 hex 串**（7/7 失败、每次重试都失败）。

要关闭 C，需要换一个"**模型有时对、有时错**"的边界形状（例如字符计数这类随机性错误），
看是否出现过 `recovered > 0`；只有"不可能任务"上的 0 恢复，不能支撑把默认值改成 0。

### 任务 E（新缺陷，优先于 C）：`delegate_batch` 的子代理能调 `subagent`，并进入无界循环

一次 letter-count 委派**从未作答**：子代理在一个 turn 内把刚收到的任务**再委派出去**，调用
`subagent` **169 次** + `list_subagent_models` 3 次，把整个 `reasoning_effort` 阶梯
（`medium`×40、`low`/`none`/`minimal` 各×21、`high`/`xhigh`/`max` 各×20）试了一遍 —— 因为本引擎
**不广告任何 reasoning effort**，每次都返回 `does not support reasoning effort "X"`，而错误文本
本身又"提示"是参数不对，于是它换一个值再试，出不来。

子代理自己的 transcript 把这个形状记死了：173 `step/start`、173 `step/end`、172 `tool/call`、
**169 个 error**，跨 **341 秒**、**24,500 output token**，prompt 从 1,970 涨到 **34,627**
（每步 ~193 token，引擎日志里能直接看到这条增长曲线和近乎全量的 prefix 复用）。
模块**完全没有拦住**：`retries` 限制的是"重跑"，不是"一次运行内部的步数"，插件一直等在
`run.result` 上，**最后是操作者手动中止 turn 才停**。

没有炸成递归：路由策略拒了第一次（`route "deepseek/deepseek-chat" is not allowed`），harness 拒了
depth 2（`subagent depth 2 exceeds maxDepth 1` ×4），**嵌套子会话 = 0**（已核对 sessions 目录）。
但引擎被占满 5.7 分钟，turn 报废。

**已修**：只有**墙钟预算**这一项，另一项已**回退**（下面第 2 点是一次买来的教训，别重犯）。

1. **每次子运行的墙钟预算**（`DSH_DELEGATE_TIMEOUT_MS`，默认 120 s）—— **这是真正起作用的那一半**。
   harness 没有步数上限可借（运行构建里根本没有 `maxSteps`/`maxTurns`），所以这是插件自己的上限：
   超时后既中止子代理，也**不再等它**（`Promise.race`，子代理忽略 signal 也劫持不了调用方），
   复用"未完成不算答案"那条路，并标 `unretryable`（预算耗尽会复现，重试只是再浪费一次）。
   已用**变异证明**它有牙齿：面对 `result` 永不 settle 的子代理，现模块 **157 ms** 返回
   `stop=aborted / attempts=1 / disposed`；把那 10 行预算逻辑剪掉后，同一个调用**挂死**（2.5 s 仍在等）。
2. **`deny` 名单不可行，已删除 —— 不要重新加**。它是"显然的配套修法"，结果不是"不生效"，而是
   **把整条委派路径打断**：`tools.restrict()` 会拿 `deny` 里每个名字去**全局工具注册表**校验，名字不认识
   就整条请求拒绝。实测原文：

   ```text
   delegation error: tools.restrict() names unknown global tools "subagent", "subagent_codex",
   "subagent_claude_code", "list_subagent_models", "wait_agent", "ralph"; known global tools:
   ask_user_question, click, … , subagent_fork, … , verify_task, workflow, write
   ```

   每个任务 ~5 ms 就失败（`attempts=3`、`0.0 s of local compute`）——不是某一个任务，是整条路。
   两个结论，第二个把当初的猜测**反过来**了：`toolFilter` **根本没法点名**造成跑飞的那个工具
   （`subagent` 由本 preset 自己的组合注册，所以不是 global 工具）；而它能点名的那些 global 委派工具
   （`subagent_fork`/`list_agents`/`send_message`/`interrupt_agent`/`workflow`/`verify_task`/
   `delegate_batch`）在 `allow: []` 下**本来就已经没了**，所以即便名字拼对也只是装饰。
   **本插件无法把 `subagent` 从子代理手里拿走，只有 harness 能。** 过滤器就应该是
   `{ allow: [] }`，自检现在钉住这一点：`deny` 键再次出现是**回归**，不是加固。

   > 这条教训比这一个参数更一般：**在这个插件里，没实测过的过滤参数不是"便宜的保险"，是"一次性打断
   > 全部委派"的办法**。预算是先证明再相信的；`deny` 是先相信后测量的，代价是一个 turn。

**仍然开着**：C（retries 默认值）要等一个"模型有时对有时错"的形状；`subagent` 无法从子代理手里移除，
只能靠预算兜底（这一条现在是**结论**，不是待验项）。

---

## 0.6 本轮实测（18:26 开的那个会话）：G 的根因在运行构建里坐实，但**本会话仍在跑旧模块**

**结论先行：这个会话跑的**不是**磁盘上那份模块**，所以 G（图片链路）在本会话里**验不了**，
只差"把 DSH 整个重启"这一步。同时：修复方向本身**是对的**，已在运行构建里取证。

### 本会话是旧模块 —— 三条互相独立的证据

| # | 证据 | 旧模块 | 新模块（磁盘上这份） |
|---|---|---|---|
| 1 | `delegate_batch` 的 `retries` **工具描述**原文 | `(default 1)` ← 本会话看到的就是这个 | `(default 0: report the FAIL and escalate instead …)` |
| 2 | **行为探针**（决定性）：不带 `retries` 派发一个"闸门必定 FAIL"的任务 | `attempts=2 · 1 retried, 0 recovered` ← 本会话实测 | 期望 `attempts=1 · 0 retried`（自检钉住） |
| 3 | 图片委派实测 | `FAIL ❌ — Unsupported or malformed image data.` + `0/1 PASS · 0.0 s of local compute`（**从未到达引擎**） | 期望 PASS |

**行为探针（复制即用，这是本文件今后判断"哪个模块实例在跑"的标准做法，不要再用 GUIDE 判断）：**

```
delegate_batch { tasks: [ { description: "which-module-probe",
  prompt: "Output ONLY raw JSON, no code fence, no prose: the JSON array [1, 2, 3].",
  verify: { kind: "json_equals", expected: "[4,5,6]" } } ] }
```

结果行 `(attempts=N)` 与 footer 的 `K retried` 直接读出默认值：`attempts=1 · 0 retried` = 磁盘那版；
`attempts=2 · 1 retried` = 旧实例。成本是一次 ~0.3 s 的本地生成。

时间线也吻合：**DSH 进程 18:12:02 启动**，而 `local-delegate.mjs` **18:16:32** 才写盘 —— 模块实例是
**每进程加载一次**；18:26 开的新会话复用了它。**"开新会话就够"这条到此彻底作废**（第 0 节当时的
观察没错，错的只是它把"GUIDE 变了"当成了"工具变了"）。

### G 的修复是对的：在运行中的 `app.asar` 里取证

新增取证工具 **`tools/asar-read.py`**（`--find` / `--grep` / `--cat`，直读 121 MB asar 的索引与单文件
负载，不必解包；本节的引用全部由它取出）：

```js
// @deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js —— 声明的存储层入参
'export interface SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name?: string; }'
// validateImage(input) 的描述原文："encoded bytes, declared media type, and optional display name."

// @deepseek-ai/dsh-attachment-local/lib/index.js —— 存储层把 data 直接交给 sharp
async function probeImage(data) { try { return await imageMetadata(sharp(data, { failOn: "error" })) }
  catch (error) { … throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE") } }

// @deepseek-ai/dsh-attachment/lib/index.js —— base64 只是 RPC **wire** 形状，harness 自己先解码
function saveInput(image) { return { data: decodeBase64(image.data), mediaType: image.mediaType, … } }

// @deepseek-ai/dsh-llm-pi-ai/lib/index.js —— 相反方向：块 → wire 时才编码
case "image": { const version = requestImages.get(block.attachment.attachmentId)
  content.push({ type: "image", data: Buffer.from(version.data).toString("base64"), mimeType: version.mediaType })
```

即：**进存储层的是字节，上 wire 的才是 base64**。模块现在是 `{ data: buf, mediaType, name }`（Buffer
就是 Uint8Array），与声明一致；插件侧发的块 `{ type:'image', attachment }`（`local-delegate.mjs:1229`）
也与适配器读的 `block.attachment.attachmentId` 对得上。

### 回归门（本轮全绿）

`node --check` ✅ · 自检 **190 passed, 0 failed** ✅ · `sync-install --check` up to date ✅ ·
`build-local-delegate-preset.py --check` up to date ✅ · 两个 bundle 的 `validate-preset-bundle` 均 valid ✅。

本轮对仓库的改动只有文档与脚本文案（**模块未改**，`local-delegate.mjs` 指纹仍是 `60B3D4DE55512D8A`）：

- `README.md` → `BCF69D15203867E0`：images 一节补"存储层收字节"的取证；新增"**新会话不是重新加载，
  进程才是**"的实测段落 + 行为探针；"Contract facts" 表加两行。
- `scripts/sync-install.mjs` → `D225D51552202305`：收尾提示从"restart the session (or start a new one)"
  改成"**restart DSH itself**（同一个进程里的新会话仍持有旧模块实例——2026-10-02 实测）"。

### 重启 DSH 之后的收尾清单 → **已完成，见 0.7**

---

## 0.7 重启后的实测（18:32:54 重启的那次会话）：0.5 的两行"待确认"全部关闭

进程启动时间 **18:32:54**，晚于模块写盘（18:16:32），所以这次是**新模块**——先用行为探针确认，再逐项收尾。

| 项 | 形状 | 实测 | 判定 |
|---|---|---|---|
| **模块身份** | 不带 `retries` 的必 FAIL 任务 | `FAIL ❌ (294 ms)`，结果行**没有** `attempts=2` 字段，footer 里**没有** `retried` → `attempts=1 · 0 retried` | ✅ 新模块（默认 0 生效） |
| **G 图片** | `img-plain.png` + `all_of ["MEN WALK ON MOON","SAMPLE 42 DELTA"]` | `PASS ✅ — all 2 found (8232 ms)`，`raw` 回显 `MEN WALK ON MOON / SAMPLE 42 DELTA`；引擎日志新增 `prompt 2469 tokens = 0 reused + 2469 read`（冷 prefill）——**图片真的进了引擎** | ✅ 关闭 |
| **A 子代理 prompt** | 同一次纯文本任务 | 引擎日志 `prompt 1952 tokens`（旧版是 ~3,5xx；上一轮记的是 1963） | ✅ 关闭，落在 1,800–2,000 带内 |
| **B 未完成运行** | 600 串数组 + 只看前两项的 `covers` | `FAIL ❌ — the child did not finish: stop=max-tokens … (39039 ms, stop=max-tokens)`，footer `— 0/1 PASS · 39.0 s of local compute`，`attempts=1`；落盘残答案 **12,712 B**，含 **210/600** 项、**两个 needle 都在**（读文件复核） | ✅ 关闭：只有 stop reason 能让它 FAIL |
| **D roster** | New Session 的预置行 | 磁盘上被加载的 `node_modules/dsh-preset-hybrid/cordis.patch.yml` 与 `bundles/` 副本都是 `Hybrid Router (legacy — pick Local Delegate for gated local work)`；本进程启动晚于同步，故应已显示 | ⏳ 只差人工眼过一眼 |

### 新发现 H（本轮实测）：图片子任务会自己去调 `subagent`，重则撞满 120 s 预算

第一次图片委派虽然 PASS，但**花了 6 步、5 次工具调用、8.2 s**。子会话 transcript 里看得一清二楚
（`tools/session-dump.mjs`，见下）：它先 `list_subagent_models` ×4 找路由，再 `subagent`（被
`subagent depth 2 exceeds maxDepth 1` 拒），第 6 步才回答——**这就是任务 E 那个暴露面，只是这次被深度上限
当场挡住、代价小**。而且子代理**确实拿得到**这两个工具：其 system 消息里就有完整的 `subagent` 工具
schema（`toolFilter: { allow: [] }` 拿不掉 preset 自己那两行注册的插件工具，与 0.5 的结论一致）。
子代理**够不到**的：`workflow`（试了 3 次，都是 `unknown tool "workflow"`，磁盘上没写出任何文件）。

**九次图片委派全记录**（五个夹具都用上了；每个子会话的步数/工具调用都是从 transcript 数出来的）：

| # | 夹具（image tokens） | prompt 里加了"不要调用任何工具" | 步数 | 子代理调用的工具 | 结果 | 墙钟 |
|---:|---|---|---:|---|---|---:|
| 1 | `img-plain` 640×480 (330) | 否 | 6 | `list_subagent_models`×4、`subagent`×1 | PASS | 8.2 s |
| 2 | `img-plain` | 否 | 2 | ×1 | FAIL（读成 `MEN WALK ON MONA`） | 0.9 s |
| 3 | `img-plain` | 否 | 2 | ×1 | PASS | 5.3 s |
| 4–6 | `img-plain` | 是 | 1 / 1 / 1 | 无 | PASS ×3 | 1.6 / 1.4 / 1.4 s |
| 7 | `img-small` 256×192 (78) | 是 | **9** | `list_subagent_models`×4、`subagent`×1、`workflow`×3 | PASS（但答案 1,061 B 全是"我的工具情况"的牢骚，读出的话在最末尾） | 14.5 s |
| 8 | `img-large` 1280×960 (1002) | 是 | **27** | `list_subagent_models`×4、`subagent`×**22** | **FAIL `stop=aborted`：撞满 120 s 预算** | 120.0 s |
| 9 | `img-photo` 800×600 JPEG (506) | 是 | 1 | 无 | PASS（"blue sky / yellow sun upper right / two green hills / brown ground"） | 1.8 s |

**结论（不要美化）**：

1. **图片链路本身是通的、闸门是对的**：9 次里 7 次 PASS；没过的两次一次是真读错、一次是预算中止，
   都按 FAIL 上报而不是把残答案收下。`prove: true` 的冒烟也在同一版上 PASS（1.4 s）。
2. **变量在子代理的行为，不在图片路径**：9 次里 6 次它去戳自己用不了的工具；`list_subagent_models`
   能用、`subagent` 永远被深度上限拒、`workflow` 真的不在。**能拦住它的只有模块自己的 120 s 预算。**
3. **"不要调用任何工具"这句话只是提示，不是修复**：前三次（4–6）确实 1 步 0 调用，但第 7、8 次
   **加了同一句话**仍然 9 步 / 27 步。7 号那次尤其说明问题：它没怎么调工具，但改用 1 KB 篇幅
   描述自己的工具清单，最后才把读出的话写出来。
4. 可操作的做法：**图片任务尽量小**（640×480、800×600 JPEG 这几次是干净的）；预期最坏情况
   是**一次 120 s 预算**的本地时间（API token 仍然是 0）；见到 `stop=aborted` 就换个更小/不同的问法，
   **绝不要拿残答案**。
5. 想更彻底只能从 harness 侧拿掉工具（本插件做不到，见 0.5），或者**缩小默认预算**——但后者会
   误杀正常的长任务，本轮**不建议**。

### 本轮新增/更新的文档与工具

- `tools/session-dump.mjs`（新）：把 `session.v4.jsonl.zstd` 解出来。**它不是一条 zstd 流，而是每次追加
  一帧的拼接**（11 KB 的子会话有 21 帧，120 s 那次有 84 帧），Node 的 `zstdDecompressSync` 只解**第一帧**
  ——直接读会"成功"地只吐出会话头 299 字节。本工具按帧魔数切开逐个解压，`--summary` 打印事件类型计数与
  `step/end`/`turn/end`。本节的步数/工具调用证据全部来自它。
- `README.md`：images 一节加"**九次图片委派的真实成本**"（含那张九行表和三条结论）；"did not finish"
  那条补本轮的 `stop=max-tokens (39039 ms)` 复核；"images 曾经坏掉"那条从"待重启确认"改成**已确认 PASS**；
  A 那条补 `prompt 1952 tokens` 复测。
- `NEXT-SESSION.md`：本节。

---

## 0.8 第三次复核（2026-10-02，本会话**跑在 hybrid 预设上**）：回归门全绿，D 的磁盘侧在四份拷贝上确认，并量到 hybrid 自己的「同版本号、两份不同代码」

**先说范围**：本会话是 `hybrid-router`（roster 上那份 legacy），不是 Local Delegate。所以 A/B/C/E/F/G 的**行为**复核在这里做没有意义——
hybrid 的 `verify_task`/`delegate_batch` 是另一份实现（本会话看到的 `delegate_batch` 描述写 `retries` `(default 1)`，而 Local Delegate 已是默认 0）。
本会话能做且做了的是**第 6 节回归门**（与预设无关，跑在磁盘上）与 **D 的磁盘侧取证**。

### 回归门（第 6 节，全绿）

| 命令 | 结果 |
|---|---|
| `node --check local-delegate.mjs` | exit 0 |
| `node local-delegate.selftest.mjs` | **190 passed, 0 failed**，exit 0 |
| `node scripts/sync-install.mjs --check` | `…\node_modules\dsh-preset-local-delegate is up to date`（5 个文件全 `same`），exit 0 |
| `python tools\build-local-delegate-preset.py --check` | `cordis.patch.yml is up to date (9134 B)`，exit 0 |
| `python tools\validate-preset-bundle.py dsh-preset-local-delegate` | valid（order 3 · 20 plugins · 26 个包全 OK） |
| `python tools\validate-preset-bundle.py dsh-preset-hybrid` | valid（order 2 · 19 plugins · 21 个包全 OK） |

### 指纹：与第 0 节的表**逐字相符**，而且源 = 安装副本（用 hash，不用肉眼）

| 文件 | 源码 | 安装副本 |
|---|---|---|
| `local-delegate.mjs` | `60B3D4DE55512D8A`（100,247 B） | `60B3D4DE55512D8A`（100,247 B） |
| `local-delegate.selftest.mjs` | `408E4DB99467824A` | `408E4DB99467824A` |
| `README.md` | `2B3EF98E1962F694` | `2B3EF98E1962F694` |
| `scripts/sync-install.mjs` | `D225D51552202305` | （不在 bundle 内） |
| `cordis.patch.yml` / `package.json` | — | `E52A9FEB360C4D38` / `3CE96894B05B9EBC` |

源码里也抽了两行与 0.5/0.7 的结论对上：`local-delegate.mjs:1504` 是 `const retries = … : 0`；`local-delegate.mjs:214-218` 列出 `covers / subset_of / union_eq / citation / python_check`。

### 模块新鲜度（第 0 节那条不变量，重新量了一次）

`local-delegate.mjs` 写盘 **18:16:32**（源与安装副本同一时刻、同一 hash）；DSH 主进程启动 **18:32:54**（另有 pid 18000 起于 18:55:50）
→ **进程晚于模块**，此后新开的 Local Delegate 会话拿到的都是修好的那份，第 0 节的前提仍然成立。
注意这条不变量只回答「将来会加载哪份字节」；本会话跑的是 hybrid，对 local-delegate 的「哪个实例在跑」没有可测对象（那要用 0.6 的行为探针）。

### D 的磁盘侧：**四份** hybrid 拷贝的标签都已是 legacy

| 拷贝 | 字节 | SHA256(16) | 结论 |
|---|---:|---|---|
| 仓库 `dsh-preset-hybrid\cordis.patch.yml` | 19,306 | `90A04EBE0D5AE986` | 标签写对，但内容落后（见下） |
| `<profile>\bundles\dsh-preset-hybrid\` | 19,653 | `9604EF7A9D770D1A` | ✅ |
| `<profile>\node_modules\dsh-preset-hybrid\`（真正被加载） | 19,653 | `9604EF7A9D770D1A` | ✅ |
| `~\.dsh\.agent-presets\hybrid-router\` | 19,653 | `9604EF7A9D770D1A` | ✅ |

四份的 `config.name` 都是 `Hybrid Router (legacy — pick Local Delegate for gated local work)`——0.7 里那个 ⏳ 只差人工看 GUI，本条**不变**，但至少能排除「标签没同步到被加载的那份」。
（`validate-preset-bundle.py` 把 em dash 印成 `??` 是控制台代码页，不是文件问题：文件里是 `—`，四份 hash 一致即证。）

### 新发现 I：hybrid 自己就有「同一个 `ROUTER_VERSION = 'v1.20.0'`，两份不同代码」——而且能判定哪份在跑

| `router-bootstrap-v34.mjs` 位置 | 字节 / 行数 | mtime | SHA256(16) | 第 64 行（`delivery_check` 描述） |
|---|---:|---|---|---|
| `<profile>\node_modules\dsh-preset-hybrid\` | 88,065 / 1320 | 2026-10-01 11:36:38 | `74B576D8FE8D8ED3` | 607 字符，`page-verify（…否则 FAIL）…（v1.23 起）` |
| `~\.dsh\.agent-presets\hybrid-router\` | 85,727 / 1281 | 2026-09-05 01:12:31 | `C29B8BBEFA910190` | 484 字符，`headless-smoke（传 url…）` |
| 仓库 `dsh-preset-hybrid\` | 85,673 / 1281 | 2026-10-01 02:19:19 | `9238551824EBCB1A` | 484 字符，同上（与 agent-presets 那份只差 6 行 `source.kind` 形状） |

**判定哪份在跑（不需要新会话、不需要委派探针）**：本会话注入的 `delivery_check` 工具描述是 607 字符那一版（含 `page-verify`、`（v1.23 起）`、`本工具不自带浏览器`），
另外两份是 484 字符的 `headless-smoke` 文案；机检的 ASCII 标记也一致（`headless-smoke` 只出现在后两份，`v1.23` 只出现在前者的**第 64 行**）。
→ **这个部署实际加载的是 `<profile>\node_modules\dsh-preset-hybrid\`，不是 `~\.dsh\.agent-presets\hybrid-router\`**；而两份的 `ROUTER_VERSION` 都写着 `v1.20.0`。

> 对 D / §5 的意义：标签修在 node_modules 那份**修对了地方**（那是被加载的那份）；而 §5「要不要彻底摘掉 hybrid」现在多了第二个实测理由——**同名、同版本号、两份不同代码**，正是这个预设自己的 README 警告过的那个「会主动骗人的信号」。
> 另：`hybrid-router` 的 README 说热重载优先改写 `~\.dsh\.agent-presets` 那份；按本次判定，那与「当前实际加载 node_modules 那份」不一致——要动 hybrid 时请用**行为/描述指纹**判定，不要用路径或版本号判定（与 0.6 的教训同源）。

### 顺带澄清 §5 的一个数字

§5 括号里那句「副本比仓库新（25,327 vs 13,651 字节）」说的是 **`router-hybrid.mjs`**（本次实测：安装副本 25,327 B / `8A3D57C2AA91196D`，仓库 13,651 B / `B985AE1E73064539`），不是 `cordis.patch.yml`。
仓库那份与「被加载的那份」不同的文件共 **4 个**：`cordis.patch.yml`、`package.json`、`router-bootstrap-v34.mjs`、`router-hybrid.mjs`；安装副本独有 `README.md`、`router-hybrid.selftest.mjs`、`cordis.patch.yml.bak-before-legacy-label`。
**所以「不要用仓库那份覆盖 profile 副本」比 §5 写的还更有分量。**

### 本轮**没做**的（1、2 已在 **0.9** 关闭，3 已在 **0.10** 关闭；只剩 4 是可选用户决策）

1. ~~**D 的 GUI 一眼**~~ → **0.9 已目视确认**：新会话页显示 `Hybrid Router (legacy — pick…`。
2. ~~**A/B/C/E/F/G 的行为复核**~~ → **0.9 已在 Local Delegate 会话里做完**（先跑行为探针确认新实例）。
3. ~~§5 的「彻底摘掉 hybrid」~~ → **0.10 已执行**（三份 profile 文件 + 备份 + 变异测试过的 roster 证明），待重启生效。
4. ~~新发现 I~~ → **0.11 已处置**：三份拷贝**先存档后删除**（用户选择"全部删掉"）。README 里「热重载读哪份」
   的说法仍留在 hybrid 自己的 README 里，但那份 README 现在只存在于归档 zip 中（0.11），不影响本部署。

---

## 0.9 第四次复核（2026-10-02 晚，**跑在 Local Delegate 上**，DSH 进程 19:02:48 启动）：D 关闭，A/B/G 在新模块上端到端复现

**第一步是行为探针**（0.6 定的判据；**不看 GUIDE、不看描述**）：把 0.6 那条原样发出——
不带 `retries` 的必 FAIL 任务（期望 `[4,5,6]`，让它输出 `[1, 2, 3]`）。实测
`FAIL ❌ — json_equals (1271 ms)`，结果行**没有** `attempts=2`、footer **没有** `retried`
→ **`attempts=1 · 0 retried` = 新模块**（磁盘那版，`local-delegate.mjs` 指纹仍是 `60B3D4DE55512D8A`，
与 0.7/0.8 同一份字节）。进程 19:02:48 晚于模块写盘 18:16:32，与此一致。

| 项 | 形状 | 本轮实测 | 判定 |
|---|---|---|---|
| **模块身份** | 上一条探针 | `attempts=1 · 0 retried` | ✅ 新模块 |
| **第 6 节回归门** | 6 条命令 | `node --check` exit 0；**190 passed, 0 failed**；`sync-install --check` up to date（5 文件全 `same`）；`build --check` `up to date (9134 B)`；两个 bundle 均 `valid` | ✅ 全绿 |
| **A 子代理 prompt** | §2 原配方（5 元素数组，内联） | 引擎日志 `prompt 1587 tokens = 0 reused + 1587 read`（冷 prefill） | ✅ 抑制生效 |
| **B 未完成运行** | 600 串数组 + 只看前两项的 `covers` | `FAIL ❌ — the child did not finish: stop=max-tokens … (54027 ms, stop=max-tokens)`，footer `— 0/1 PASS · 54.0 s of local compute`；`outputFile` **13,208 B**，含 **234/600** 项、**两个 needle 都在**（脚本数出来的，不是肉眼） | ✅ 只有 stop reason 能 FAIL |
| **G 图片链路** | `img-plain.png` + `all_of ["MEN WALK ON MOON","SAMPLE 42 DELTA"]` | `PASS ✅ — all 2 found (1454 ms)`，1 步；引擎日志 `prompt 2079 tokens = 0 reused + 2079 read`（冷 prefill → **图片真的进了引擎**） | ✅ |
| **D roster（GUI 目视）** | 新会话页的预置行 | 显示 **`Hybrid Router (legacy — pick…`**（下拉宽度把后半截截掉，`legacy` 标记可见） | ✅ **关闭**（0.7/0.8 的 ⏳ 到此结束） |

**D 是怎么做的（可复现，本会话有 GUI 观察面）**：`see(handle=<DSH 窗口句柄>)` → `click` 侧栏「新会话」→
再 `see` 读预置行 → 点侧栏原会话切回。⚠️ 这一步**会切换用户界面视图**（可恢复，但会打断用户当下看到的画面），
只在确实需要目视时才做；磁盘侧的四份拷贝取证（0.8）仍然是不打扰用户的那条路。

> ⚠️ **顺带看到的一条未修隐患（新）**：新会话页的预置**默认**停在 `Hybrid Router (legacy …)`（应为"上次用过"的记忆），
> 也就是说点「新会话」后直接发消息，拿到的是**弱闸门那一份**（10 个 kind、无 `prove`、无图像、无子代理抑制、无 stop 检查）。
> 这让 §5「彻底摘掉 hybrid」不只是清理，而是**消掉一个"默认选错就静默换弱闸门"的入口**——但仍是用户决策，本轮只取证。

**A 那个数字的诚实处理**：三个会话分别量到 `1963 / 1952 / 1587`，都在预测带内、都远低于只做工具剥离的 `3522`。
**~370 token 的跨会话漂移不是 GUIDE**（GUIDE 是 1,633 token，是这三个会话共同*缺失*的那一项）；它跟着别的
会话级提示内容走（技能目录/工作区指令一类），本轮**没有**去查因。三处都写进了 README，没有把 1,587 说成是"修复更好"。

**本轮改的东西**：只有 `README.md`（A/B/G 三条各补第三次实测；已 `sync-install`）。**模块一行未改**，
所以第 6 节回归门在文档同步后又跑了一遍全绿。§5 与新发现 I **未动**（两者都要动 profile 侧文件/三份拷贝，属用户决策）。

---

## 0.10 §5 已执行（用户拍板后，本会话动手）：hybrid 从 profile 清单里摘掉 —— **已在 19:13:43 那次重启后的进程里生效，见 0.12**

用户选择了「摘掉 hybrid」。改了 profile 目录（`%USERPROFILE%\.dsh\profiles\desktop\`）的**三份**文件，
改前全部备份并逐字节核对（`orig == bak` 已打印确认）：

| 文件 | 改动 | 备份（原名 + `.bak-before-hybrid-removal`） |
|---|---|---|
| `package.json` | `dependencies` 与 `dsh.profile.bundles` 里各删 `dsh-preset-hybrid` 一行 | 原 `05CFCEB16894DE51` |
| `cordis.patch.yml` | `agent-preset-registry.selectedDefault: hybrid-router` → **`local-delegate`**；上方注释里 "see the hybrid-router preset" 一并改成 local-delegate | 原 `F386BD571849823D` |
| `pnpm-lock.yaml` | 删 importer / packages / snapshots 三处 hybrid 条目，保持 manifest ↔ lock 自洽 | 原 `2A77C970D8A06997` |

**为什么 `selectedDefault` 必须一起改**（在**运行构建**里取证，不是猜的）：

```js
// @deepseek-ai/dsh-agent-preset-registry/lib/index.js
static Config = z.object({ default: z.string().required(), selectedDefault: z.string().volatile() });
/** Default preset for a subsequently created session. */
get defaultId() { return this.config.selectedDefault.get() ?? this.config.default; }
```

那个 `hybrid-router` 正是 **0.9 里看到「新会话默认停在 Hybrid Router」的原因**。摘掉 bundle 后若留着这个 id，
`defaultId` 会指向一个不再存在的预置。改成 `local-delegate` 后，新会话默认落在**强闸门**那份上。

**为什么必须删 `dependencies` 那一行**（只删 `bundles` 会被自动加回来）：

```js
// @deepseek-ai/dsh-app-boot/lib/index.js — reconcileProfilePlugins()（在 package-manager 操作成功后调用）
const bundles = previous.filter((name) => !(beforeNames.has(name) || afterNames.has(name)) || bundleNames.has(name));
for (const dependency of after.dependencies)
  if (dependency.bundle && !disabled.has(dependency.name) && !bundles.includes(dependency.name)) bundles.push(dependency.name);
```

即"**dependency 管着的条目，删掉就消失；新出现的 bundle dependency 会自动激活**"。所以 §5 当初写的
"`bundles` 一行（以及 `dependencies` 里对应的一行）"是**唯一自洽**的改法 —— 只删 `bundles` 是**无效**的。

**摘除的安全性核对**（全部机检，不是眼看）：

- profile patch 层只 patch base 插件 id（`ui-chat` / `llm-pi-ai` / `agent-default-model` / `agent-preset-registry` /
  `permission` / `ui-conversation` / `subagent`…），**0 处**引用 hybrid 独有 id；
- 其余活动 bundle（`dsh-base` / `dsh-web-app` / `vision` / `dsh-session-sync`）的 `cordis.patch.yml`，对
  `router-bootstrap|router-hybrid|preset-hybrid-router|gitbash|tool-str-replace-editor` 的匹配数 = **0**；
- home 层 `~\.dsh\cordis.patch.yml` **不存在**（`$DSH_HOME/cordis.patch.yml` 是 profile-boot 提到的另一个 patch 层）；
- 改后三份文件 JSON/YAML **均可解析**，`hybrid` 残留引用 **0**（备份里仍是 2/2/6，反证改动确实落盘）；
- `.agent-presets/hybrid-router/` 这套 legacy 布局**不会被本构建读取**：`preset.yml` 在整个 `app.asar` 里
  **0 命中**，roster 来自 bundle 声明的预置插件（`preset-hybrid-router`）—— 所以**摘 bundle 就是删 roster 行**。

**生效条件与验收**：patch 层与预置 roster 都在**启动时**读取，所以必须**重启 DSH**。
本会话**故意没有重启**（重启会掐掉正在进行的会话）。重启后应看到：

1. 新会话页的预置列表里**没有** `Hybrid Router` 一行；
2. `dsh.profile.bundles` 是 5 项（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`vision`、
   `dsh-session-sync`、`dsh-preset-local-delegate`）；
3. 新会话的默认预置是 **Local Delegate**（0.9 那条"默认落到弱闸门"的隐患随之消失）。

**roster 的静态证明（不必重启，用运行构建求解）**：新增 **`tools/check-profile-roster.py`**。它按启动时的
同一顺序合成 patch 栈 —— `dsh.profile.bundles` 顺序取每个 bundle 的 `dsh.bundle.patch`，再 profile 层、
再 home 层（`$DSH_HOME/cordis.patch.yml`）；bundle 先在 profile 的 `node_modules` 找，找不到就到**运行中的
`app.asar`** 里找；然后列出 roster 行（`name == '@deepseek-ai/dsh-agent-preset'` 的条目，**含 `insert:` 嵌套**）
与 `agent-preset-registry` 的有效默认值（`defaultId = selectedDefault ?? default`）。本机实测：

```text
layers  : @deepseek-ai/dsh-base./cordis.patch.yml
          @deepseek-ai/dsh-web-app./cordis.patch.yml
          @deepseek-ai/dsh-web-app./presets/{standard,ptc,minimal,cordis}.patch.yml
          vision./cordis.patch.yml
          dsh-session-sync./cordis.patch.yml
          dsh-preset-local-delegate./cordis.patch.yml
          <profile>\cordis.patch.yml
roster (5 rows): standard / ptc / minimal / cordis / local-delegate   ← hybrid-router 不在
agent-preset-registry: default='standard' selectedDefault='local-delegate'
OK: 5 presets, effective default 'local-delegate' resolves
```

**它有牙齿**（变异测试跑在 **junction 隔离的 profile 拷贝**上，没有碰真 profile）：

| 变异 | 期望 | 实测 |
|---|---|---|
| `selectedDefault: hybrid-router`（roster 里没有它） | 必须 FAIL | ✅ `PROBLEM: effective default 'hybrid-router' is not in the roster …` |
| 删掉 `dsh-preset-local-delegate` 的 manifest 两行 | 必须 FAIL | ✅ 只剩 4 行 + 同一个 dangling 判定 |
| **正对照**：把 hybrid 两行加回去 | 必须**看得见** hybrid | ✅ 6 行，含 `hybrid-router  Hybrid Router (legacy — pick Local Delegate…)` |
| bundle 名改成不存在的包 | 必须 FAIL | ✅ `PROBLEM: bundle not resolvable` |

变异 3 是关键：它证明检查器**不是**因为"看不见 hybrid"才说"没有 hybrid"。

**这条证明覆盖什么、不覆盖什么**（诚实边界）：覆盖 patch 栈的**文件级**合成结果（= 重启后 roster 的内容）
以及"没有任何指针悬空"；**不覆盖运行中的进程**（本会话没有重启，GUI 此刻仍是旧 roster），也不重放
`--patch` 覆盖层与 flag 派生 patch（本机没用），不执行 `prepareProfileEntries` 的版本门控。
**它证明的是文件，不是进程** —— 进程级确认仍然要那次重启。

**回滚**：把三份 `*.bak-before-hybrid-removal` 复制回原名（上表哈希可用于确认取对了文件），重启即可。

**改后的指纹**（`SHA256(16)`，供将来确认这三份没被人再动过）：
`package.json` = `04CFC7AAAEFBA2B0`（501 B，原 `05CFCEB16894DE51`）·
`cordis.patch.yml` = `6BA708F611E7BE10`（2,536 B，原 `F386BD571849823D`）·
`pnpm-lock.yaml` = `526A37A69C664450`（1,905 B，原 `2A77C970D8A06997`）。

**当时有意没动的**（**已被 0.11 取代** —— 用户随后选择全部删掉，见 0.11）：`node_modules\dsh-preset-hybrid\`、
`bundles\dsh-preset-hybrid\`、`~\.dsh\.agent-presets\hybrid-router\` 当时都留在磁盘上，因为它们已不参与加载。
**注意：这三份现在都已删除**，0.10 那个"把 hybrid 加回去"的正对照变异要复跑，必须先解 0.11 的归档 zip。

---

## 0.11 新发现 I 已处置（用户拍板：**全部删掉**）：三份 hybrid 拷贝先存档、后删除

**决定**：把 `node_modules\`、`bundles\`、`~\.dsh\.agent-presets\` 三份 hybrid 全部删掉（含 `node_modules` 那份）。

**删之前发现的东西，它改变了做法**（按"删前先核目标"的规矩先做了只读盘点）：

| 文件 | 三份副本里 | 仓库 `dsh-preset-hybrid\` 里 |
|---|---|---|
| `router-hybrid.mjs` | **25,327 B / `8A3D57C2AA91196D`** | 13,651 B / `B985AE1E73064539`（正是 `bundles\` 里那个 `.bak-before-enhance`） |
| `cordis.patch.yml` | 19,653 B / `9604EF7A9D770D1A` | 19,306 B / `90A04EBE0D5AE986` |

`bundles\` 那份**带 `.git`，但救不了**：`HEAD:router-hybrid.mjs` 是 **23,692 B** 的旧版，而 25,327 B 是**未提交的
工作区改动**（`git status` 正好两条 `M`：`cordis.patch.yml`、`router-hybrid.mjs`）。
→ **直接删就是不可恢复的丢失**，所以先存档。

**存档**（已解压逐文件复核哈希与原件一致；90 个条目）：

| | |
|---|---|
| 路径 | `C:\Users\14339\Desktop\git\Strata\dsh-preset-hybrid.removed-2026-10-02.zip` |
| 大小 / SHA256(16) | 377,315 B / `F76653AF06EEA90B` |
| 内部布局 | `A-profile-node_modules/dsh-preset-hybrid/`、`B-profile-bundles/dsh-preset-hybrid/`（含 `.git`）、`C-agent-presets/hybrid-router/` |

**已删除**（删前逐个解析绝对路径并确认**都不是 reparse point**；删后逐个 `Test-Path` 复核为 False）：

```text
C:\Users\14339\.dsh\profiles\desktop\node_modules\dsh-preset-hybrid   → 已删
C:\Users\14339\.dsh\profiles\desktop\bundles\dsh-preset-hybrid        → 已删（含 .git）
C:\Users\14339\.dsh\.agent-presets\hybrid-router                      → 已删
```

`node_modules\.pnpm` 不存在（profile 用 hoisted 布局），所以没有第四份。删后复核：roster 检查仍
`OK: 5 presets`、自检 **190 passed, 0 failed**、`sync-install --check` 与 `build --check` 均 up to date。

**故意没删的两处 —— 它们不是 bundle 拷贝**：

1. `~\.dsh\sessions\--C-Users-14339-.dsh-profiles-desktop-bundles-dsh-preset-hybrid--\` —— 那是**会话记录**。
   ⚠️ 它的 cwd 已随 bundle 消失，**重开那个会话可能报错**（会话文件本身没动，只是工作目录没了）。
2. `~\.dsh\_backup-20261001-011851\router-hybrid.mjs` —— 你在 10-01 留下的更早备份，与本次无关。

**两个后果（重要）**：

1. **回滚不再只是复制那三份 manifest 备份**：`package.json.bak-before-hybrid-removal` 会把清单指回一个
   **已不存在的** `bundles\dsh-preset-hybrid`。要回滚，必须**先从上面的 zip 把 B 份解到 `bundles\dsh-preset-hybrid`**，
   再复制三份备份、重启。（否则 `check-profile-roster.py` 会直接报 `bundle not resolvable`。）
2. 0.10 那个"把 hybrid 加回去"的**正对照变异（M3）在本机已无法复跑** —— 夹具就是那份 bundle。要复跑先解 zip；
   **zip 因此同时是那个变异测试的夹具来源**，别把 zip 也删了。

---

## 0.12 进程级验收（目标轮）：**抓到一个真缺陷并修好**；hybrid 摘除在运行进程里得到证实

**前提已满足**：用户在 **19:13:43** 重启了 DSH，晚于我改动 profile 的 **19:10:27–19:10:29**，且 `cordis.yml`
在该时刻被重新生成 → 这次进程加载的就是新 patch 栈。

### 决定性证据（全部来自**运行中的进程**，不是文件）

| 证据 | 读数 | 含义 |
|---|---|---|
| 本进程新建的子会话头部 | `0e4c2fc6…` → `"agentPreset":"local-delegate"` | 运行进程给**新**会话用的就是 `local-delegate`（服务端解析，不含任何文件层假设） |
| 委派冒烟（新进程） | `PASS ✅ — json_equals (1418 ms)`，结果行无 `attempts=2` → `attempts=1` | 预设在新进程里功能正常 |
| 点「新会话」时的报错 | `agent-preset/not-found: Unknown agent preset: hybrid-router` | **运行进程的 roster 里已经没有 `hybrid-router`** —— 否则 `resolve()` 会成功。这是摘除生效的**反证式**证据，比文件级证明更强 |

### 新缺陷（只有进程级验收才看得见）：一个"空白会话"把「新会话」整条路堵死

运行构建里的解析点（`@deepseek-ai/dsh-agent-preset-registry/lib/index.js`）：

```js
async resolve(id) { const wanted = id ?? this.defaultId;
  const record = this.definitions.get(wanted);
  if (record === void 0) throw new RemoteError("agent-preset/not-found", `Unknown agent preset: ${wanted}`,
    { agentPreset: wanted, available: [...this.definitions.keys()] }); /* … */ }
```

而客户端建会话时**不传预置** —— `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`：
`this.sessions.create({ workspaceId: workspace.workspaceId })`；但它会**复用工作区里的空白会话**
（`connectWorkspace` → `reuseBlank(workspaceId, id)` → `sessions.create({ workspaceId, sessionId })`）。

于是：`session-68ecaa86-2289-4a40-814b-fd740b182c5e`（**341 B，19:05 建，只有 4 条记录** = header + 策略/权限/沙箱，
**没有任何对话**）在头部记着 `agentPreset: "hybrid-router"`。hybrid 一被摘掉，服务端一合成它就抛 `not-found`
→ **点「新会话」必然失败**（每次都会，与点几次无关）。

**范围是机检的**（新工具 `tools/session-headers.mjs`，逐会话只解第一帧）：全部 **165** 个会话按预置分布
`standard=46 / hybrid-router=42 / local-delegate=76 / cordis=1`，其中**空白且指向已删预置的只有这一个**；
其余 41 个 `hybrid-router` 会话都是 `origin=subagent` 的子会话，不在这条路径上。

**修法（可逆、逐帧校验）**：把这个空白会话头部的预置改成合法的 `local-delegate`。新工具
`tools/session-set-preset.mjs` 默认 **dry-run**，`--write` 才落盘；它只重写**第 0 帧**，其余帧**逐字节不动**，
自动留备份并逐帧复核：

```text
node tools/session-set-preset.mjs <…>/session-68ecaa86-…/session.v4.jsonl.zstd --preset local-delegate --write \
     --backup-dir %USERPROFILE%\.dsh\_removed-sessions
  agentPreset : hybrid-router  ->  local-delegate
  other frames: 1 (left byte-for-byte unchanged)
  backup      : C:\Users\14339\.dsh\_removed-sessions\session.v4.jsonl.zstd.bak-before-preset-hybrid-router
  verified    : agentPreset=local-delegate  records 4 -> 4  tail-identical=true
```

复检：`session-headers.mjs --preset hybrid-router --blank` → **0 个**；分布变为
`hybrid-router=41 / local-delegate=77`，会话总数仍 165、该会话记录数 4（内容一条没少）。
（中途曾把它整个移出 `sessions` 树，随后**移回原位**再改头部 —— 因为服务端可能缓存会话列表，
"改头部"比"让它消失"更稳；移回后 dry-run 确认行为一致。）

> ⚠️ **如果点「新会话」仍然失败**：说明服务端把该会话的头部**缓存在内存里**（它 19:13:43 启动时读的
> 就是 `hybrid-router` 那版），而这次的修复只落在**磁盘**上。处置：**再重启一次 DSH**（磁盘侧已经是
> `local-delegate`，重启后重新读头部即可）。判据不用猜：`node tools/session-headers.mjs --preset hybrid-router --blank`
> 返回 0 就说明磁盘是对的，剩下的只可能是内存缓存。

### 本轮**仍没做成**的一件事：那一次 GUI 点击（卡在安全机制上，不是漏做）

本应点一次「新会话」确认页面正常打开、预置选择器只剩 5 行。**没做**：鼠标停在屏幕 **(0,0)**，
pyautogui 的 **fail-safe 触发**（它把"鼠标顶到角落"当作人类的紧急中止）。这是**用户级安全机制**，
本轮**没有**用 Win32 `SetCursorPos` 之类绕过去。请人工点一次确认（预期：页面正常打开、列表 5 行、
默认 **Local Delegate**、不再出现 `Unknown agent preset`）。

### 这一节带来的两条可复用结论

1. **"删掉一个预置"从来不只是删 manifest**：会话在头部记住自己的预置，而"空白会话复用"会把一个历史
   id 拖进**新建会话**这条路径。以后任何预置下线，先跑
   `node tools/session-headers.mjs --preset <被删的 id> --blank`，有输出就先处置（改头部或归档会话）。
2. **文件级证明（0.10/0.11）确实挡不住这个缺陷**：`check-profile-roster.py` 全程 `OK: 5 presets`，
   而进程里「新会话」是坏的。这正是交接单反复强调"进程级验收"的价值 —— 这一轮把它兑现了。

---

## 1. 三十秒自检：这个会话跑的是新模块吗

> ⚠️ **先读 0.6：下面这张表只能看出 GUIDE 是不是新的，而 GUIDE 每轮都会重新求值 —— 它变新不等于
> 模块变新。**判断"哪个模块实例在跑"请用 0.6 节的**行为探针**（看 `attempts`/`retried`）。

在**新会话**里回答以下问题（看自己的系统提示即可，不需要调工具）：

| 问题 | 新模块的答案 | 旧模块（说明会话是改之前开的） |
|---|---|---|
| `verify_task` 的 `kind` 列表里有 `covers`/`subset_of`/`union_eq`/`citation`/`python_check` 吗？ | **有，16 个 kind** | 只有 11 个 |
| `verify_task` 有 `prove` 参数吗？ | 有 | 没有 |
| `delegate_batch` 的描述提到 `outputFile`（完整答案落盘）吗？ | 提到 | 没有 |
| 路由指南里有"**READ THE WHOLE ANSWER**"这条吗？ | 有 | 没有 |
| 路由指南里有"**A PASS 的答案更长的会写文件**"和"prove 必须同时接受好答案"吗？ | 有 | 没有 |
| 路由指南里有 `DSH_DELEGATE_TIMEOUT_MS`（**子运行墙钟预算**）这条吗？ | **有** | 没有 |
| `delegate_batch` 的 `retries` 描述里写着 **`default 0`** 吗？（并说明"FAIL 上报、由调用方升级"） | **有** | 没有（旧版是 `default 1`） |
| 路由指南里的贪心那条有没有附上"**greedy 不等于可复现**"的实测更正？ | 有 | 没有（旧版只说 greedy） |
| 路由指南里的语义版本那条有没有附上"**2/2 首次就正确**"的反例？ | 有 | 没有（旧版只说 DO NOT） |

**任何一项是旧答案 → 这个会话也是旧模块，别做下面的验证，重新开一个会话。**

> ⚠️ **另有一个"坏版本"要认出来**：如果一次 `delegate_batch` 报
> `tools.restrict() names unknown global tools "subagent"…`，那说明这个会话的工具绑定停留在**中间版本**
> （有预算、也有一份已被删掉的 `deny` 名单，指纹 `AFB14936C85935FB`）。**那个版本每一次委派都失败**
> （~5 ms，`attempts=3`）。**开新会话**（不是"再等一轮"）即可，磁盘上已经是修好的版本。

---

## 2. 任务 A：确认子代理不再背那段路由 GUIDE（预期 ~3,540 → ~1,900 tokens）

**背景**：GUIDE 实测 **6,679 字符 = 1,633 prompt tokens**，原先占被派发子代理提示的约 46%，每次派发都付。现在该段文本是**函数**：顶层 agent 拿到 GUIDE，子代理拿到空串（判据是 harness 自己的委派深度 `max(session.header.delegationDepth, options.subagentDepth)`）。

**做法**（一次即可，任务要小）：

1. 记录日志当前行数：
   ```powershell
   $log = "C:\Users\14339\Desktop\git\Strata\strata-coder-iq1_m.log"
   (Get-Content $log | Select-String "prompt \d+ tokens").Count
   ```
2. 调用一次 `delegate_batch`，**只放 1 个任务**、文本内联、带确定性校验器。例：
   ```
   delegate_batch { tasks: [ { description: "probe",
     prompt: "Output ONLY raw JSON, no code fence, no prose: the JSON array [10, 20, 30, 40, 50].",
     verify: { kind: "json_equals", expected: "[10,20,30,40,50]" } } ] }
   ```
3. 读引擎日志**最后一行** `prompt N tokens = …`：
   ```powershell
   Get-Content $log | Select-String "prompt \d+ tokens" | Select-Object -Last 1 | ForEach-Object { $_.Line }
   ```

**判定**

| 观察 | 含义 |
|---|---|
| `prompt ~1,800–2,000 tokens` | ✅ 抑制生效，**把这行数字写进 README 的诚实边界那条，并把"待关闭"改成已关闭** |
| `prompt ~3,500 tokens` | ❌ 抑制没生效（子代理判据没匹配上）。检查 `isDelegatedChild`：在**运行构建**里 `AgentOptions.subagentDepth` / header `delegationDepth` 是否仍是这两个字段 |
| 日志里没有新行 | 引擎没被调用：先 `delegate_batch` 是否报 `local engine unreachable`，再确认 `GET http://127.0.0.1:8080/health` |

顺带确认（同一次调用就能看到）：结果行的 `(N ms)` 和批次 footer `— 1/1 PASS · X.X s of local compute` 都出现了，说明耗时/汇总已生效。

---

## 3. 任务 B：确认"没跑完的运行不算答案"（端到端，约 80–120 秒本地算力）

**背景**：`SubagentResult` 带 `stopReason`（`completed | aborted | error | max-tokens | refusal`），而模块原先只读 `output`——于是**一个撞上 token 上限的子代理，其残答案只要满足闸门就会被当成功收下**。现在 stop reason 在判决**之前**检查并压倒它。

**做法**：构造一个"残答案也满足闸门"的请求：让模型输出很长（超过 `DSH_LOCAL_MAX_TOKENS=4096`），但校验器只看开头就通过。

```
delegate_batch { tasks: [ { description: "truncation probe",
  prompt: "Output ONLY raw JSON, no code fence, no prose: a JSON array of 600 strings. String i must be exactly \"item i: alpha bravo charlie delta echo foxtrot golf\". Do not stop early.",
  verify: { kind: "covers", expected: "[\"item 1: alpha\",\"item 2: alpha\"]" } } ] }
```

（`covers` 只看两个 needle 是否出现，前两项就满足；所以**只有** stop reason 能把这条判失败。）

**判定**

| 观察 | 含义 |
|---|---|
| `FAIL ❌ — the child did not finish: stop=max-tokens … a partial answer is never accepted` | ✅ 修复生效（`stop=aborted`/`error` 也算正确，重点是非 completed 不得 PASS） |
| `PASS ✅` | ❌ 仍在旧模块，或修复回归。**这是安全漏洞复现**：残答案被当成功收下 |
| 跑了很久但 `stop=completed` | 模型自己收尾了、没撞上限。把数组加长（800/1000 项）再试，或把 `DSH_LOCAL_MAX_TOKENS` 调小后**重开会话**（该值在模块加载时读取） |

注意：这一条会占用引擎 1–2 分钟，期间别并发别的本地调用。

---

## 4. 任务 C：`retries` 默认值 —— **已决定并落地：默认 0**

> **结论（本轮做出）**：`const retries = … : 0`，工具描述也写明 `default 0`，自检钉住（默认不重试、
> 显式 `retries: 1` 仍会重试；把默认改回 1 会让那条断言单独失败）。
> 依据：10 次同形状观察（7 次反转 hex 串，每次尝试都是**完成的**错误答案而非中止 + 3 次算术干净失败）
> 全部 `retried > 0`、`recovered == 0`；重试可能撞满 120 s 预算；而"改问法/拆输入"只有调用方能做，
> 预设契约本来就是 FAIL→升级 DeepSeek。
> **诚实边界**：这 10 次都是模型做不出的任务，所以量到的是"重发救不了没希望的任务"；
> "模型偶尔能做的任务"仍未测。要推翻这个默认值，需要**先**出现一个 `recovered > 0` 的反例
> （下面保留探针配方，供那时使用）。

### 下面的配方保留，供将来复现或推翻这个决定

**背景（已更正）**：默认 `retries: 1`。原文的理由是"引擎贪心（温度 0），重发很可能**是同一份采购买两次**"
—— **这条前提已被证伪**：同一个 prompt 三次尝试生成 86/50/44、321/46/57、49/48/54 token，**每次答案都不同**，
重试是"**不同的**采购"，只是价格一样。所以"重试没用"这个结论**不能**从"它是重复购买"推出来，
必须**实测**：在一个"模型有时对、有时错"的形状上，看重试是否救回过一次。

**先决条件**：新会话里**第一次委派必须不报** `tools.restrict() names unknown global tools`（那是坏版本，
见第 0/1 节）。确认命令（1 个任务、文本内联）：

```
delegate_batch { tasks: [ { description: "smoke",
  prompt: "Output ONLY raw JSON, no code fence, no prose: the JSON array [10, 20, 30, 40, 50].",
  verify: { kind: "json_equals", expected: "[10,20,30,40,50]" } } ] }
```

**探针形状**：**随机 hex 串的逐字复现**（`json_equals`，期望值是那个 JSON 字符串）。
选它的理由：难度**可调**，而且已知两端 ——

| 长度 | 实测 |
|---|---|
| 128 字符 | **2/2 通过**（模型能复现） |
| 反转 20–48 字符 | 7/7 失败（这是"不可能任务"，**不要**用它测 recovered，0 恢复是必然的） |

所以边界带在 128 字符以上某个位置：**先用 `retries: 2` 打 2 个任务**（例：160 / 200 字符，字符串见下），
若都通过就把长度往上（256 / 320），若都失败就往下 —— 目标是找到"一次成功概率在 30–70%"的长度。

160 字符（用于验证坏模块已修）：
```
9c757aad5c62ad745a69a39e64da0af61fd3ec97506307312024639725cffe938b97d2232245e1cfbba9407411087b15040c99c0a5b9c4465502c19ef82b45527fdfa13139d52f0573bfcea284ffb77f
```
200 字符：
```
67126f3f13e5c64eadbde3cacbc135871391220bd93064cd66c8865ecfce5dff26a97db8e9df56785666c5d215c37574b40568c9d9a6f78d1ceeaa133bae50c6bebc94710c6cfaa5f7b12ac996a2043865590723d885be8c09e3c97a7caa7facb48a091f
```

模板（把 `<HEX>` 换成上面任一串，`<HEX>` 出现两次）：

```
delegate_batch { retries: 2, tasks: [ { description: "copy",
  prompt: "Output ONLY raw JSON, no code fence, no prose: a JSON string containing exactly this text: <HEX>",
  verify: { kind: "json_equals", expected: "\"<HEX>\"" } } ] }
```

**必须同时做的监视**（这是 `subagent` 跑飞那次的教训）：派发前把
`%TEMP%\engine-watchdog.ps1` 以**后台任务**跑起来（它每 2 s 采样引擎日志；只对**新出现**的请求报警，
prompt 显著增长就是子代理在绕圈），派发后读它的输出，再 `job_kill`。
⚠️ 读看门狗时注意**批次可能还在飞行中**：那次我看到"返回后请求还在涨"，实际是批次尚未返回，
子代理的 `turn/end` 正好落在预算那一刻（+120.018 s）。判断"是否还在跑"要看**子会话的
mtime 与 `turn/end` 记录**，不要只看自己以为的返回时刻。

**已经跑过的两组（本轮实测，结论：这两个形状都不够干净）**

| 形状 | 结果 |
|---|---|
| 逐字复现 128 / 160 字符 | **PASS**（160 用了 11.4 s、好几步；单次生成约 2 s） |
| 逐字复现 200 字符 | **不是答错，是绕圈**：110 步 / 109 个工具调用（`list_subagent_models` ×104、`subagent` ×4、`run_subagent` ×1），120 s 预算中止 |
| 12 位 × 12 位乘法（输出只有 25 位数字） | 任务 a：第 1 次 ~5 s **干净答错**，第 2 次绕圈到预算；任务 b：第 1、2 次（~7 s、~1 s）**干净答错**，第 3 次绕圈到预算。合计 `2 retried, 0 recovered` |

所以：**算术形状能产生"完成的错误答案"**（正是 C 需要的），但重试有相当概率转成绕圈，
使观察变脏、且每次绕圈要付 120 s。**下一次请先把预算调小**（`DSH_DELEGATE_TIMEOUT_MS=30000`，
它**每次调用都会读**，所以在启动 DSH 的环境里设即可，不必改模块、不必重启会话），
这样一个绕圈的重试只花 30 s；然后把 12 位乘法换成**同样短输出**的算术题，
累计 ≥5 次"干净失败 + 重试也干净失败"的观察，再判 `recovered`。

**判定与动作**

| 累计观察 | 动作 |
|---|---|
| 在**边界形状**上多次 `retried > 0` 且 `recovered == 0`（≥5 次同形状、且每次重试都是**干净答案**） | 把默认值改成 `0`（`const retries = … : 1` → `: 0`），并在 README 写明依据；重试的替代是"**拆小输入/换问法**"，不是原样重发 |
| 出现过 `recovered > 0` | 保留默认 1，把反例写进 README |
| 重试**绕圈到预算**（而非给出干净答案） | 这次观察**不算数**（`stop=aborted` 不是"模型又答错了一次"），但要记下来：它同时说明该形状的重试成本可能是整个预算 |

---

## 5. 任务 D：hybrid 预置的 roster 标签（人工在 GUI 看）—— **已关闭（0.9 目视确认、0.10 彻底摘除）**

两个预置都在 roster 上，而 hybrid 的委派层更弱（10 个 kind、无 `prove`、无图像、无子代理抑制、无 stop 检查），且它有**第二份会漂移的闸门实现**——选错它是静默换弱闸门。

已改：`profile` 副本与仓库副本的 `name`/`description` 都写明它是 legacy、被 Local Delegate 取代（schema 已确认对 `name`/`description` 无长度限制）。

> ⚠️ **更正（见 0.5，已修）**：这里说的"`profile` 副本"其实只是
> `<profile>/bundles/dsh-preset-hybrid/`，而 **DSH 真正加载的是
> `<profile>/node_modules/dsh-preset-hybrid/`**，那一份**从未被同步**，标签一直是裸的
> `Hybrid Router`。已用 bundle 自带的 `node scripts/sync-installs.mjs --write` 同步
> （当时唯一不同的文件就是 `cordis.patch.yml`，模块全部逐字节相同），现在两个 target 都是
> `All targets already match this tree`。**roster 行在启动时读取，必须重启 DSH 才看得到。**

**做法**：New Session 界面的预置列表里应看到
`Hybrid Router (legacy — pick Local Delegate for gated local work)`。

- 看到 → ✅
- 没看到 → 需要**重启 DSH**（预置声明在启动时读取，改 patch 不热更）。

> ✅ **已执行：见 0.10**（2026-10-02，用户拍板后）。原来这里的做法是对的，且 0.10 在运行构建里补上了
> **为什么必须两行都删**（只删 `bundles` 会被 `reconcileProfilePlugins` 自动加回来）与
> **为什么 `selectedDefault` 必须一起改**（它是"下个新会话的默认预置"）。下面这段保留为当时的原始记录：
>
> 若要**彻底摘掉** hybrid（推荐方向：一个部署只留一个委派预置）：在
> `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里删 `dsh-preset-hybrid`
> 一行（以及 `dependencies` 里对应的一行），改前先备份该文件。**不要**用仓库那份去覆盖 profile 副本——
> 副本比仓库**新**（25,327 vs 13,651 字节，且带未提交改动）。

---

## 6. 回归门（每次改完都跑，全部要绿）

```powershell
cd C:\Users\14339\Desktop\git\Strata\dsh-preset-local-delegate
node --check local-delegate.mjs
node local-delegate.selftest.mjs                     # 期望 190 passed, 0 failed
node scripts/sync-install.mjs --check                # 期望 up to date
cd ..
python tools\build-local-delegate-preset.py --check  # 期望 cordis.patch.yml is up to date
python tools\validate-preset-bundle.py dsh-preset-local-delegate
python tools\validate-preset-bundle.py dsh-preset-hybrid
python tools\check-profile-roster.py                    # 期望 OK: 5 presets，有效默认能解析（见 0.10）
node tools\session-headers.mjs --preset hybrid-router --blank   # 期望 0（见 0.12：非 0 就会堵死「新会话」）
```

改了模块后：`node scripts/sync-install.mjs` 同步，然后**再开一个新会话**才生效。

> ⚠️ **一次性的自检崩溃（0.10 观测，未复现）**：在一条连着跑好几个 node/python 的命令里，自检曾经以
> `exit=-1073740791`（`0xC0000409`，fail-fast abort）中断，输出停在测试中途、没有 `190 passed`。
> 随后 **6/6 复跑全绿**（3 次走 `| Select-Object -Last 2`、3 次整段捕获），模块字节未变
> （`60B3D4DE55512D8A`）。所以：见到这个退出码**先原样复跑一次**，不要当成预设的缺陷，也不要直接判红。

---

## 7. 不要重复的两个错（上一轮踩过）

1. **不要一次性派发大批量**。`delegate_batch` 是**串行**的：4 任务 × 3 次尝试 = 12 次本地生成，会把 turn 拖到被用户中止（报错长这样：`Error: aborted`，它来自 `exec.signal.aborted`，不是引擎坏了）。单次 **≤2 个任务**。
2. **不要在后台留递归遍历**。上一轮一条 `Get-ChildItem -Recurse` 扫 `deepseek-harness` 整个 monorepo 在后台跑了很久、抢磁盘，加剧了上面的问题。用 `glob`/`grep` 工具，或限定目录。
   另外：用 PowerShell 按命令行匹配杀进程时，**别把要匹配的字符串写进自己的命令行**——上一轮因此把自己的 pwsh 杀了（用运行时拼接的字符串 + 排除 `$PID`）。

---

## 8. 结果写回哪里

| 测到的东西 | 写到 |
|---|---|
| A 的子代理 prompt token 数 | `README.md` → "Honest boundaries" 那条（把"To close the loop"改成实测值） |
| B 的观察（FAIL/stop 值） | `README.md` 的 "A run that did not finish is not an answer" 那条；若复现了 PASS，这是**新缺陷**，要新开一轮修 |
| C 的 `retried/recovered` 累计 | 决定是否改 `retries` 默认值，并把依据写进 README |
| 任何"只有在运行构建里才成立"的结论 | 都必须在 `app.asar` 里取证，不引用旁边的检出 |

---

## 附：这个预置现在有什么（一句话版）

`standard` 预置**逐字** + 一行能力：可被机器校验的子任务派给本地 Strata 引擎（0 API token），答案必须过**确定性校验器**才被采用，失败则升级回 DeepSeek。16 个校验 kind（其中 5 个**不需要先知道答案**）、`prove` 先证闸门有两个方向（拒绝坏答案 **且** 接受好答案）、PASS 的长答案落盘回传、未完成运行不算答案、子代理不再背路由指南。

> 版本提醒：桌面 app 是 **0.2.0-rc.2**，`..\deepseek-harness` 检出是 `dsh-v0.1.7-rc.2`。
> 凡涉及 harness 内部的判断，一律以**运行中的 `app.asar`** 为准。
