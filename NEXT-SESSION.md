# 新会话交接单 — `local-delegate` 预设的收尾验证

## 最新一轮（2026-10-18）：预设在新桌面版上**全线失败**——`{{cwd}}`（已修，**待重启 DSH**）

> **本节优先于下面所有记录。**

### 症状（用户原话）

```
unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model
```

用这个预设的**每个新会话都起不来**。注意它没有自己的 transcript：失败发生在**提示词组装**阶段、任何模型请求之前，
所以按"看会话记录找线索"的路子会一无所获。

### 根因

`cordis.patch.yml` 是 `standard` 基线**逐字拷贝**的，而旧基线里带着这一行：

```yaml
- id: persona
  config:
    prefix: You are a coding agent powered by the {{model}} model.
    suffix: Your working directory is {{cwd}}.
```

persona 的 `prefix`/`suffix` 是**模板**，提示词注册表对 `{{…}}` 严格解析；当前构建（桌面版 0.2.0-rc.2）只注册
`provider` 和 `model`——工作目录改由**工作目录服务**作为字面用户上下文提供，`cwd` 这个变量已经不存在。
所以那句 suffix 既渲染不了也多余。这不是"换模型"带来的，是**跟随基线拷贝**带来的漂移。

### 已做的修复

1. 重新生成 `cordis.patch.yml`（顺带修正了基线的真实漂移：新增 `time-context`、`tool-schedule`，
   少了 codex/claude-code 两个 subagent 行，plan-mode 文案更新）——suffix 那行随之消失。
2. `tools/build-local-delegate-preset.py` 加了守卫 `check_prompt_variables()`：写出前拒绝 `{{provider, model}}`
   之外的任何 `{{…}}`，并打印行号与成因；`--selftest` 用一段合成的 `{{cwd}}` 钉住这条（变异证明：
   对旧版本报 1 条、对新版本报 0 条）。
3. README.md / README.en.md 各加一节记录此坑。

### 还差一步：**重启 DSH 本体**

组合是**进程启动时**读的。这次的进程起于 **14:20:16**，文件修于 **14:23:14**——进程内存里仍是那句坏 suffix，
所以**现在新建会话照样失败**。重启后才会读到修好的组合。换模型那次的教训在这里再次适用：文件对了 ≠ 生效了。

### 附带核实（值得记住）

- profile 里那份 bundle 与源码目录是**硬链接**（`nlink = 2`，`ino` 相同），所以改源码会同时改掉"已安装"的预设，
  `sync-install --check` 对 `cordis.patch.yml` **永远不会**报 stale。别把它当成"还没 install"。
- 本地引擎此刻**没在跑**（`127.0.0.1:8080` 拒绝连接），所以 selftest 要用 `DSH_SKIP_ENGINE_PROBE=1` 跑（229/0）；
  真发委派前先起引擎。

---

## 最新一轮（2026-10-15）：本地模型 **IQ2_XS → IQ3_S**

> **本节优先于下面所有记录。** 读这一节就能开工。

### 0. 状态（逐项实测）

| 层 | 值 | 怎么确认 |
|---|---|---|
| 模型 | **qwen3.8-flash-next-iq3_s**（3.5-bit 通用，文件在 `D:\Strata-data`） | `curl --noproxy "*" http://127.0.0.1:8080/health` → `{"model":"qwen3.8-flash-next-iq3_s","max_context":262144,"images":true,"loaded":true}` |
| 配置 | `strata-iq3_s.json`，与旧 `strata-iq2_xs.json` **逐项一致**：`--max-context 262144 --kv int8 --kv-resident 32768 --spec 4 --spec-min-p 0.5 --vision --vram-reserve-mib 700`；唯一差别是**没有** `"host": "0.0.0.0"` | 直接读文件 |
| 推理档位 | **`low`**，写在 `strata-iq3_s.shared-settings.json`，**且不含 temperature**（见坑 A） | `GET /settings` → `{"shared":true,"defaults":{"reasoning_effort":"low"}}` |
| DSH 路由 | `strata/qwen3.8-flash-next-iq3_s`（`cordis.patch.yml` 两处：provider 模型行 + `allowedModels`） | `list_subagent_models provider=strata` |
| preset | `LOCAL_MODEL` 默认改为 iq3_s；GUIDE 里基于 IQ2_XS 的实测数字按 IQ3_S 重测后改写；selftest **229 / 0** | `node local-delegate.selftest.mjs` |
| ⚠ **未完成** | **`sync-install` + 重启 DSH 还没做**，所以此刻委派仍会被拒（见 §1） | `node scripts/sync-install.mjs --check` → 退出码 1 |

### 1. 换模型的正确顺序（本轮把 README 顶部那条坑原样复现了一次）

1. 引擎侧：`setup.py --yes --family qwen --model IQ3_S --context 262144 --data-dir D:\Strata-data --vision gpu --no-start --vram-reserve-mib 700`
   → 下载 + 建 pack + 生成 `strata-iq3_s.json` / `run-iq3_s.bat`（本轮约 1 小时，见 §2）
2. 起引擎：`start-strata.ps1 -Config ...\strata-iq3_s.json`（WMI 起，脱离本进程树）
3. 引擎侧 shared settings：`POST /settings {"defaults":{"reasoning_effort":"low"}}`
4. DSH 侧：改 `~/.dsh/profiles/desktop/cordis.patch.yml` 两处模型 id
5. **`node scripts/sync-install.mjs` 把 `dsh-preset-local-delegate` 复制进 `<profile>/node_modules/`**
6. **重启 DSH 本体**

第 5、6 步缺一不可。本轮在第 4 步之后、第 5/6 步之前实测到的**症状**：

```
subagent { provider:"strata", model:"qwen3.8-flash-next-iq2_xs" }
→ Error: child LLM route "strata/qwen3.8-flash-next-iq2_xs" is not allowed for this Session
delegate_batch → 每个任务 stop=error、0 token、约 0.5 s
```

因为 profile 的允许列表已经读到 `iq3_s`，而**进程里那份 preset 模块的 `LOCAL_MODEL` 还是 `iq2_xs`**
（模块每进程加载一次；GUIDE 文本每轮重算，工具绑定不重算）。
`node tools/session-route-policy.mjs --model qwen3.8-flash-next-iq3_s` 本轮报告：
**8 个旧主会话**钉在已删除的 `iq2_xs`（`dead-route`），`allows-local: 0`。

### 2. 下载与建包（实测）

| 项 | 值 |
|---|---|
| shard 1 | `…-IQ3_S-00001-of-00002.gguf` **51.05 GiB**（下载器显示 54.82 GB 十进制） |
| shard 2 | setup 判定与 IQ2_XS **同一文件**（identical），直接复用，**没有重复下载** |
| pack | `D:\Strata-data\packs\iq3_s`，1079 张量 / 302 走 native / arena **1.43 GiB** |
| 专家 arena | **46.84 GiB**，加载 **5.86 GiB/s** |
| D: 剩余 | 178.9 GB → **126.4 GB** |

### 3. IQ3_S 实测（2026-10-15，本机 RTX 5070 Ti 16 GB + 69.6 GB RAM）

`bench-toolmodel.py`（3 种采样 × 6 个工具任务）：

| 配置 | 通过 | 中位延迟 | tok/s |
|---|---|---|---|
| greedy | **6/6** | 0.71 s | 55.5 |
| t0.3 | **6/6** | 0.61 s | 88.2 |
| t0.6 + min_p 0.05 | **6/6** | 0.61 s | 96.3 |

**旧模型那条"版号排序必错"没了**：`3.10, 2.7, 3.9, 2.11` → `['2.7','2.11','3.9','3.10']`，三种配置全对
（IQ2_XS 上实测 0/5，见下一节的记录）。这是换 3.5-bit 最直接的收益。

思考档位（"120 件，卖 1/3，再卖剩下的 1/4，再加 60"）：

| effort | 答案 | 生成 token | 耗时 |
|---|---|---|---|
| `none` | **100 ❌** | 4 | 0.64 s |
| `low` | **120 ✅** | 97 | 1.69 s |
| `medium` | 120 ✅ | 135 | 1.69 s |
| `high` | 120 ✅ | 73 | 1.31 s |

**`none` 的失败在 3.5-bit 上原样复现** → 这是思考通道的限制，不是量化的锅（GUIDE 已按此改写）。

视觉（`bench-vision.py`，读数全部正确）：

| 指标 | IQ2_XS | IQ3_S |
|---|---|---|
| 读图像 token 中位（引擎 prompt_ms） | 658 ms | **836 ms**（558–1178） |
| 编码首次 / 缓存 | 97 / 42 ms | 150 / 43 ms |
| 单图首帧 wall | 0.7–2.5 s | 1.1–2.5 s |

### 3b. 思考档位实测（2026-10-15，IQ3_S，`bench-thinking-levels.py`）

14 题 × 4 档 × 3 次采样 = 168 次调用，题分三类：机械 5 题（抽取/计数/可执行代码/版号排序/明示抽取）、
多步推理 6 题（三段百分比、两段路程时间、折扣再税、时间差、工人天数、水池净流入）、逻辑 3 题（循环追踪、三段论有效性、谁最矮）。

| 思考档 | 机械 5 题 | 多步推理 6 题 | 逻辑 3 题 | 合计 | 中位延迟 |
|---|---|---|---|---|---|
| `none` | 15/15 | **9/18** | **6/9** | 30/42 | 0.17 s |
| **`low`（当前）** | 12/15 | **18/18** | **9/9** | 39/42 | 1.21 s |
| `medium` | 14/15 | 18/18 | 9/9 | 41/42 | 1.38 s |
| `high` | 15/15 | 18/18 | 9/9 | 42/42 | 1.58 s |

1. **`none` 的损失是能力级的**：6 道推理题里 3 道 **0/3**（三段百分比答 `110`、两段路程时间答 `4.5`、
   折扣再税答 `42.3`），逻辑组循环追踪也 0/3（答 `10`）。`low` 起推理 18/18、逻辑 9/9。
2. **`low` 已经吃满收益**：low = medium = high 在推理/逻辑两组都满分，延迟 1.21 / 1.38 / 1.58 s。
   **当前部署的 `low` 就是最优档**，往上只是多花时间。
3. **机械组与档位无关**，唯一失分在"抽动词(原措辞)"（low 0/3、medium 2/3、high 3/3，none 3/3）。
   这不是退化：原措辞是"extract every distinct verb that starts a sentence"，而每句开头是 "The"，
   `low` 的思考原文写着 *"starts with 'The', not a verb"*，按字面就该给 `[]`。**同一题改成明示措辞
   （"each sentence looks like 'The <thing> <verb> ...'"）后每个档位都 3/3，包括 low** —— 这一对是证据，
   不是猜的。**歧义措辞 + 思考 = 字面理解。**
4. 自证坑：本脚本第一版的数字检查器按**字面字符串**匹配，把 `high` 的正确作答 `37.80` 判成 FAIL
   （期望 `37.8`）。改成按数值比较，并用 9 个判别用例自证（`37.80==37.8`、`1200≠120`、`4.5≠6`…）。
   任何"模型失败"先怀疑检查器。

### 4. 这次换模型的真正代价是内存，不是速度

引擎加载时的原话：

```
memory guard: limit 69.6 GiB, current 26.6 GiB, available 43.1 GiB
WARNING: the expert arena needs 46.84 GiB of RAM but 39.04 GiB is available (7.80 GiB short)
loaded 46.84 GiB at 5.86 GiB/s
Windows commit: 3.1 GiB left of a 98.7 GiB limit … it can end at the limit with no message (exit code 0xC0000409)
only 482 MiB of VRAM free … Add --vram-reserve-mib 1280
```

即：**arena 差 7.8 GiB**、加载后整机只剩约 6 GB 可用 RAM / 3.1 GiB commit、显存剩 370–536 MiB。
速度实测没问题（§3），但引擎自己把 commit 上限标成了崩溃风险。若要更稳：抬高页面文件、
或 `--max-context 131072`（KV 3.09 GiB → 约 1.5 GiB）、或 `--vram-reserve-mib 1280`（换更小的专家缓存）。
**本轮没有改这三项**——先按用户选定的 262144 跑，风险如实记在这里。

### 4b. 长提示词 / 长会话压测（2026-10-15，同一进程 PID 35404，全程未崩）

上面那条 commit 警告是**加载时的一次性预测**（"计划 2.0 GiB 主机分配"），实测**没有兑现成增长**：

| 测试 | 结果 | commit | 工作集 |
|---|---|---|---|
| `tools/needle_bench.py` 32k @50% | FOUND，32,789 tok，12 s | 90.7 → 90.7 | +0.18 GB |
| 128k @10/50/90% | **3/3 FOUND**，124,879 tok，38–43 s | 90.8 → 91.1 | −4.2 GB |
| 200k @50% | FOUND，198,079 tok，44 s | 91.2 → 91.0 | 持平 |
| **满窗口** 267000 @10/50/90% | **3/3 FOUND**，257,742 tok，87–91 s | 91.0 → 91.2 | −2.7 GB |
| `tools/conversation_growth_needle.py` 8 轮 ×40K 字符 | 8/8，最慢 5.5 s，末轮 read 34 / reused 86,170，**暗号 FOUND** | 91.2 → 91.4 | +1.25 GB |
| 同上 12 轮 ×60K 字符（终态 **205,237 tok**） | 12/12，最慢 9.1 s，末轮 read 35 / reused 205,202，**暗号 FOUND** | 91.5 → 91.4 | +0.4 GB |

结论：**两种压力各跑到接近上限都没有触发 0xC0000409，也没有 OOM**；单轮 257,742-token 提示词的
prefill 约 2,900 tok/s，会话每轮只付新增的约 12–20K token（前缀复用 86K→205K）。
`/metrics` 同时澄清了一件事：本部署的 **conversation cache 是关的**（`conversation_cache_mib: 0`、
`enabled: false`、`parked: 0`）——所以上面那个 `reused` 是**引擎对同一序列的前缀复用**，不是"停放的会话缓存"。
吃内存的是 `arena_mib: 47962`（46.84 GiB pinned 专家）与 `expert_cache_mib: 5988`（显存）。

顺带纠正一条旧断言：README 状态表里"可靠上下文 ≤ 142K（145K 不稳定、231K 必失败）"是 **IQ2_XS 时代**的实测；
在 IQ3_S 上 **257,742 token 三个深度全对**（3/3，只测了一轮长度，不足以直接改写那条，但值得重扫一遍）。

### 5. 坑 A：`shared-settings.json` 会偷偷给每次委派加上采样

`strata-iq2_xs.shared-settings.json` 里当时是 `temperature 0.6`，而 `serve/server.py` 的 `_run` 是
`defaults = {**self.sampling_defaults, **self.shared}`——**委派请求不带 temperature，所以每一次委派都在按 0.6 采样**，
而配置里看着还是"贪心"。这文件是网页 Chat 页写的。
IQ3_S 这份只写 `{"reasoning_effort": "low"}`，**不要再往里塞 temperature**。

### 6. 同日：引擎 0.1.43.1 → **0.1.44.1**（上游 282 个提交）

`git fetch`（走代理 4 秒）显示本地落后 origin/main **282 个提交**，上游已发 **v0.1.44 / v0.1.44.1**，
`MIN_ENGINE` 也升到 `(0,1,44,1)`。做法：`git stash push -- .gitignore serve/web/app.js` → `git pull --ff-only`
（纯快进，无冲突；上游对 `app.js` 的 hunk 在第 73/103/1081 行，我们的改动在第 557 行）→ `git stash pop`
→ 停引擎 → `setup.py --update` → 重启。

| 项 | 0.1.43.1 | **0.1.44.1** |
|---|---|---|
| 引擎 `strata.exe` | 160.5 MB / `AA690AE65BFD306D` | **181.2 MB / `BD18453F65B4D03B`** |
| memory guard 加载时 | current 26.6 / available 43.1 GiB | **12.9 / 56.8 GiB** |
| arena 差 7.8 GiB 警告 | 出现 | **没有出现** |
| Windows commit（**加载时**） | 3.1 GiB left / 98.7 | 6.6 GiB left / 94.6 |
| 工具任务 greedy | 6/6 · 0.71 s · 55.5 tok/s | 6/6 · 0.68 s · **63.0 tok/s** |
| 128K 针 | FOUND · 43 s | FOUND · 43 s |
| 专家缓存槽 / 显存 | 3053 / 5988 MiB | **3155 / 6188 MiB** |
| 推理组 none → low | 9/18 → 18/18 | 9/18 → **18/18** |

**⚠ 上表的"内存更宽裕"是加载时快照，别当成收益 —— 同一天的稳态复测（2026-10-15 晚）：**

| 稳态指标 | 0.1.43.1 | 0.1.44.1 |
|---|---|---|
| 系统 commit 已用 | 90.7–91.6 GB | **90.8 GB（一样）** |
| `arena_mib`（引擎真正的主机分配） | 47962 | **47962（逐字节相同）** |
| strata 工作集 | 28.7–35.6 GB | **46.0 GB**（私有提交 66.2 GB） |
| 页面文件 / commit 上限 | 30 GB / 99.7 GB | **25 GB / 94.6 GB** |
| commit 余量 | 引擎报 3.1 GiB | **3.8 GiB** |

所以：**换引擎没有减少内存占用，紧度也没解除**。两处"看起来变多/变好"都有解释：
① 工作集 29–36 GB → 46 GB 是**驻留口径**（46.8 GiB arena 用 `cudaHostRegister PORTABLE` 注册，系统可以把它裁到待机列表，被裁时工作集就小），**分配没变**；
② 加载时那次"6.6 GiB 余量"是**当时机器更干净**（刚下完的 51 GB 文件缓存已被丢弃，Cache 仅 0.3 GB，available 56.8 GiB），而旧引擎是下载后立刻加载（available 43.1 GiB），所以那条 arena 警告没出现**不是引擎变省了**；
③ 页面文件被 Windows 从 30 GB 缩到 25 GB，commit 上限降 5 GB。

`setup.py --update` **没有改动任何配置**（`strata-iq3_s.json` 与更新前备份逐行一致）。

**两个坑（都实测）：**

1. **`--update` 不走代理**：它从 GitHub Releases 直连拉 `strata-windows-x64.zip`，实测 **96 KB/s**（10 分钟 5%）；
   设 `HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:10808` 后 **2.94 MB/s（≈30×）**，整包 20 秒。
   `git` 的 `http.proxy` 配置它**不读**。
2. **中途 kill 会删掉 `engine/BUILD.json`，之后更新静默变空操作**：`update_installed_engine` 第一行是
   `if not info.exists(): return`，所以第二次跑打印 "[ok] Strata is updated (engine 0.1.43.1)" 却什么都没做
   （末行版本是从 exe 读的，不报错）。恢复备份的 `BUILD.json` 再跑即修复；判断换没换**只看 exe 的大小与 SHA-256**。

### 7. 同日的上下文实验：262144 → 131072 → **调回 262144**

> **最终状态：`--max-context 262144`（模型训练长度），profile `contextWindow 262144` / `maxTokens 65536`。**
> 中间那次 131072 是省内存实验，同日按用户要求撤回。两组数字都留在这里，**别把 131072 当成当前状态**。

配置 `strata-iq3_s.json` 的 `--max-context` 曾改成 `131072`，profile 同步 `131072`/`32768`（**两处必须与
`/health` 的 `max_context` 对齐**，否则 harness 按一个引擎没有的窗口开会话）；同日两边都改回 `262144`/`65536`。

| 指标 | 262144（当前） | 131072（实验） | 变化 |
|---|---|---|---|
| KV 常驻 RAM | 3.09 GiB | **1.55 GiB** | −1.54 GiB |
| 物理可用 RAM | **0.8 GB** | 4.5 GB | 131072 明显宽裕 |
| commit 已用 / 上限 | 90.8 / 94.6（余 3.8 GiB） | 88.3 / 94.6（余 8.1 GiB） | 131072 多 4.3 GiB |
| 显存空闲（加载后） | **73 MiB，引擎标 LOW**（它建议 `--vram-reserve-mib 1139`） | 有裕量 | 262144 明显更紧 |
| 专家缓存槽（显存） | 3164 | 3254 | — |
| `arena_mib`（专家） | 47962 | 47962 | 不变，仍是最大头 |

功能验收：131072 时 `/health` → `131072`，128K 针（125,011 token）深度 10/90 **2/2 FOUND，45 s**；
`bench-toolmodel.py` 第一次出现 greedy **5/6**，**复跑三次全部 18/18**（这台引擎贪心也不可复现，见 GUIDE）——单次 5/6 是抖动，不是上下文变更的回归。
调回 262144 后：`/health` → `262144`，**200K 针 FOUND（200,095 token，76 s）**；代价是物理可用 RAM 掉到 0.8 GB、
显存只剩 73 MiB（引擎警告 requests may stall）。

**还没做的**：profile 的改动要**重启 DSH 本体**才生效（`contextWindow` 是启动时读的）。当前引擎窗口是 262144，
DSH 未重启时按 131072 开会话——**这个方向是安全的**（提前压缩，不会 400），重启后即对齐。
想省内存：`--kv q4_0`（KV −1.4 GiB）、`--prompt-cache 2`（−0.47 GiB）、去掉 `--vision`（−2.0 GiB）、
`--resident-experts`（−40 GiB 量级但显著变慢）、`--vram-reserve-mib 1139`（把显存还回去，专家缓存变小）。
`--ple-io` 保持默认 `direct`（表不进 RAM）；`--kv-resident` 别再降（方向相反，会把 KV 挪回 RAM）。

### 8. 2026-10-16：模型换成 **IQ3_XXS**（内存换档，能力实测不降）

> **当前状态：模型 `qwen3.8-flash-next-iq3_xxs`、`--max-context 262144`、`--kv int8`、engine 0.1.44.1。**
> IQ3_S 的文件先留着（回退用）；注意两者的 **shard 2 是同一硬链接**，删任一份都不会释放那 26.82 GiB。

为什么换：IQ3_S 在 262144 下把整机逼到物理可用 **0.7 GB**、commit 余 5.4 GB、显存只剩 73 MiB；
IQ3_XXS 的专家 arena 小 6.9 GiB，正好补上这个缺口。下载走 **ModelScope**（HF 直连已不通、代理也只有 0.15 MB/s；
`--source modelscope` 实测 11–36 MB/s，47.04 GB 约 40 分钟；shard 2 直接复用同一硬链接）。

| 指标 | IQ3_S | **IQ3_XXS** |
|---|---|---|
| 专家 arena（`arena_mib`） | 47962 MiB / 46.84 GiB | **40925 MiB / 39.97 GiB** |
| 物理可用 RAM | 0.7 GB | **10.9 GB** |
| commit 已用 / 余量 | 89.3 / 5.4 GB | **80.5 / 14.2 GB** |
| commit 余量（加载时引擎口径） | 8.1 GiB | **15.9 GiB** |
| 专家缓存槽（显存） | 3164 | **4158** |
| 显存空闲 | 73 MiB（建议 `--vram-reserve-mib 1139`） | **174 MiB**（建议 1038） |
| 工具任务 greedy / t0.3 / t0.6 | 6/6 · 6/6 · 6/6 | **6/6 · 6/6 · 6/6** |
| 中位延迟 / tok/s（greedy） | 0.68 s · 63.0 | **0.59 s · 70.7** |
| t0.6 + min_p（最快档） | 0.61 s · 93.3 | **0.53 s · 101.9** |
| 200K 针 | FOUND · 76 s | **FOUND · 200,095 tok · 76 s** |
| 推理组 `none` → `low` | 9/18 → 18/18 | **9/18 → 18/18** |

判读：**能力与速度都测不出差别（甚至略快），换来的是 6.9 GiB 主机内存**——这是"降内存"里唯一幅度够大又不掉速的一招。
DSH 侧同步改了：profile 的 `models[0].id` 与 `allowedModels` → `qwen3.8-flash-next-iq3_xxs`（`agent-default-model` 由用户保持在
deepseek-official），preset 的 `LOCAL_MODEL` 默认值 → iq3_xxs，`sync-install` 已同步、selftest 229/0、指纹 `BAC60126866B4D9C`（123,872 B）。

**必须做的**：**重启 DSH 本体**。否则进程里那份 preset 还是 `iq3_s`，而引擎已经在服务 `iq3_xxs` →
委派会报 `child LLM route "strata/qwen3.8-flash-next-iq3_s" is not allowed for this Session`（这条坑见 §1）。

---
## 最新一轮（2026-10-13 二轮）：状态全绿，`subagent` 已恢复，并修好两个**误导性诊断**

> **本节优先于下面所有记录（含上一轮那份 2026-10-13「引擎/模型换代」）。** 读这一节就能开工。

### 0. 状态（逐项实测，与上一轮的表逐条对上）

| 层 | 值 | 怎么确认 |
|---|---|---|
| 引擎 | `engine/BUILD.json` = **0.1.43.1**（`source: release`、cuda 13.0、vision gpu） | 直接读文件 |
| Strata 源码 | `a0116b27` | `git -C <strata> log --oneline -1` |
| 模型 | **qwen3.8-flash-next-iq2_xs**，`loaded: true`、`images: true` | `curl http://127.0.0.1:8080/health` |
| 引擎窗口 | **262144** | 同上（`max_context`） |
| 推理档位 | **`low`** —— 由多步算术答 `120` 反证（坑 B 的正解），不是读了配置就说 | 见 §5 |
| DSH 路由 | `strata/qwen3.8-flash-next-iq2_xs`（`list_subagent_models` 只回名字，**不广告任何 reasoning effort**） | `list_subagent_models` |
| preset | 源码 ⇄ 安装副本**逐字节一致**（新指纹见 §9），selftest **202 / 0**（见 §11、§12） | `node scripts/sync-install.mjs --check` |
| **`subagent` 工具** | **可用**（上一轮那条未决项已关闭） | 见 §2 |
| **本版字节在运行进程里** | **已确认**——两个修复的原始形状在重启后的进程里都按预测发生 | 见 §8 末表（**0.6 旧探针区分不出本版**） |

### 1. 上一轮 §5 定的三条开局自检：全绿

| 检查 | 结果 |
|---|---|
| `curl --noproxy "*" http://127.0.0.1:8080/health` | `{"status":"ok","model":"qwen3.8-flash-next-iq2_xs","max_context":262144,"images":true,"loaded":true}` |
| `node scripts/sync-install.mjs --check` | 5 个文件全 `same`，exit 0 |
| `node local-delegate.selftest.mjs` | **195 passed, 0 failed**（改动前）→ **199 passed, 0 failed**（本轮加了 4 条，见 §7） |

### 2. 上一轮 §3 第一条未决项**已关闭**：`subagent` 在新主会话里可用

上一轮的根因判断是对的：拒的是**会话级快照** `subagentModelSelectionPolicy`（值仍是**已被删除**的
`qwen3.8-flash-next-coder-iq1_m`），它写在父会话头部、子会话继承，**跨重启保留**，所以那个会话里怎么试都没用。

本轮在一个**新主会话**里直接调：

```
subagent { description: "subagent route probe", provider: "strata",
           model: "qwen3.8-flash-next-iq2_xs", run_in_background: false,
           prompt: "Output ONLY this raw JSON …: [7, 8, 9]" }
→ [7, 8, 9]     （没有 "is not allowed for this Session"）
```

旁证（机检，不是眼看）：profile patch 的 `allowedModels` **只有新模型名**；整个 `profiles\desktop` 里
旧模型名的残留**只剩 3 处，全在 `cordis.patch.yml.bak-before-hybrid-removal`**（备份，不参与加载）。
**结论：不需要改 profile，换主会话即可**；这条不再是未决项。

**但「换主会话即可」这句话本身要数清楚才敢说** —— 那个策略是**会话级 durable projection**
（`@deepseek-ai/dsh-tool-subagent`：`init: () => null`，而 `recordSubagentModelSelection` 发现已有值就**直接 return**），
所以**每个老会话都被永久钉在它创建时的那份清单上**。新增工具 `tools/session-route-policy.mjs`
（只读，逐会话解到策略那一帧就停）实测本机 **248 个会话 / 47 个主会话**：

| 主会话（depth 0）的策略 | 数量 | 含义 |
|---|---:|---|
| `allows-local` | **2** | 含当前模型（其中一个是本轮这个会话） |
| `dead-route` | **23** | 钉在**已删除**的 `…coder-iq1_m` 上（22 个 strata + 1 个 qwen provider） |
| `no-local-route` | **10** | 更早的清单，只有 deepseek/qwen 路由，从来没有本地引擎 |
| `no-policy-record` | **12** | 无策略 = 不限制（固定路由） |

→ **47 个主会话里只有 2 个允许本地路由；另外 33 个里 `subagent` 带着本地路由会被拒**
（`child LLM route "…" is not allowed for this Session`，~23 ms）。
**`delegate_batch` 不受影响**（它用预设自己的路由，不走会话策略）——这一点 10-13 那轮在
`session-e0b91597`（正是上表里 dead-route 的第一行）里实测过：`subagent` 被拒、`delegate_batch` 一切正常。

**处置**：老会话里继续用 `delegate_batch`，或**新开一个会话**（新会话拿到当前 `allowedModels`）。
本轮**没有**去改写那 23 个会话的策略帧 —— 它不是系统性阻塞（0.12 那个空白会话会堵死「新会话」整条路，
这个只影响"在被钉住的老会话里用 `subagent`"），而改会话文件按 0.12 的经验还要防内存缓存。
若哪天真要批量修，照 `tools/session-set-preset.mjs` 的形状做（默认 dry-run、只改相关那一帧、逐帧复核）。
**任何换模型的部署都要跑一次这个工具**，否则「本地模型能不能接到任务」在这个会话里的答案会被静默改变。

### 3. 模块身份（0.6 的行为探针，不看 GUIDE）

不带 `retries` 的必 FAIL 任务（期望 `[4,5,6]`、让它输出 `[1, 2, 3]`）→
`FAIL ❌ — json_equals (2743 ms)`，结果行**没有** `attempts=2`、footer **没有** `retried`
→ **`attempts=1 · 0 retried` = 磁盘那版新模块**（`retries` 默认 0 生效）。

### 4. 回归门（§6 全部 8 条，改完并 sync 之后复跑，全绿）

`node --check` exit 0 · 自检 **199 / 0** · `sync-install --check` up to date（同步前它如期报 3 个 `STALE`，
这正是坑 A 的用法）· `build-local-delegate-preset.py --check` `up to date (9134 B)` ·
两个 bundle `validate-preset-bundle` 均 `valid` · `check-profile-roster.py`
**`OK: 5 presets, effective default 'local-delegate' resolves`** ·
`session-headers.mjs --preset hybrid-router --blank` = **0**（0.12 那个「空白会话堵死新会话」的缺陷没有复发；
会话总数已涨到 244）。

> 本轮 roster 比 0.10 记录**多了一层** `dsh-project-memory./cordis.patch.yml`（新装的 bundle）。
> 不影响结论：仍是 5 行预置、有效默认仍是 `local-delegate`。

### 5. 端到端复核：上一轮 §7 的形状清单，在 0.1.43.1 + IQ2_XS @ `low` 上**全部通过**

6 批 11 个任务、**≈23.6 s 本地算力、0 API token**（数字取自各批 footer，不是估算）：

| 形状 | 门 | 实测 |
|---|---|---|
| 多步算术（120 件，卖 1/3 → 卖余 1/4 → 进 60） | `exact` | ✅ `got="120"`（2.5 s）—— **这就是 `low` 生效的证据**（`none` 会答 100） |
| JSON 抽取（host/port/secure） | `json_equals` | ✅（2.4 s） |
| 分类·划分（6 项分 fruits/vegetables） | `union_eq` | ✅ `union equals the universe (6 items, none filed twice)`（2.3 s） |
| 摘要（覆盖 3 个机器取出的符号名） | `covers` + **`prove: true`** | ✅ `all 3 covered`（2.3 s）——prove 先证后跑，正常 |
| 格式化（13 October 2026 → ISO） | `regex` | ✅（2.1 s，**不带 prove**，理由见 §6 缺陷 2） |
| 可执行代码（`is_prime`，6 条断言） | `python_exec` | ✅（2.4 s） |
| 计数（5 个元音） | `count` | ✅ `len=5`（1.9 s） |
| **图像 OCR** | `all_of` | ✅ `all 2 found`（2.1 s） |
| 真引用 / 伪造引用 | `citation`（`verify_task` 直调） | ✅ PASS / ✅ `FAIL — the evidence is fake: the quote is not in README.md:64 (±1)` |
| 业务不变量 | `python_check`（`verify_task` 直调） | ✅ `python-check ok` |

**视觉夹具要重建**：上一轮那 5 张 `%TEMP%\vision-fixtures\` 已被系统清理，本轮用 PIL 重新生成了
`img-plain.png`（640×480、白底黑字、**44 px** 字，两张各一行）——一次 PASS，**1 步、无工具调用**。
做法记在 §10，下次直接复用。

### 6. 本轮新发现并修好的**两个真缺陷**（都是误导性诊断；各自都真实花掉了一次委派）

两个都是在**照着上一轮 §7 的清单派发**时撞上的，不是翻代码翻出来的。

**缺陷 1 —— `python_exec` 的 `asserts` 只吃表达式，写完整语句会报「Python 语法错误」**

```text
现象：asserts: ["assert is_prime(2) is True"]
      → FAIL — Command failed: … probe.py, line 14
               assert (assert is_prime(2) is True)
               SyntaxError: invalid syntax
根因：local-delegate.mjs 把每条 assert 包成 `assert (${a})`。契约（schema）写的是 "assertion
      expressions"，但字段名就叫 `asserts`，写完整语句是最自然的读法。报错落在**生成出来的代码**上，
      于是它指向模型的代码（这里是完全正确的 `is_prime`），指错了半边 —— 我据此白花了一次委派。
修复：包之前先剥掉行首的 `assert` 关键字（`assert` 是 Python 关键字，合法表达式不可能以它开头）。
      两种写法都行；自检两条钉住（见 §7），**把剥离去掉就恰好那两条失败**。
证据：同一份 `is_prime` 用表达式写 → PASS（2.4 s）；新字节在独立进程里，语句写法 `ok:true`、
      表达式写法 `ok:true`、**假断言仍然 `AssertionError`（证明剥离没把断言变成空操作）**。
```

**缺陷 2 —— `prove` 在四类「无结构算子」的门上永远无法认证，而 GUIDE 却叫调用方去传 `prove.positive`**

```text
现象：给 regex 任务带 prove: {positive: "2026-10-13"}（positive 是对的、也被接受了）→
      FAIL — prove: gate has no power — `regex` has no structural mutant operator and its positive
             example cannot be derived, so `prove` can never certify it …
根因（两层）：
  (a) 文案是**假的**：调用方刚刚**提供了** positive 且它被接受（positiveOk=true），
      却被告知「positive example cannot be derived」；而且它没说这个任务**根本没跑**、也没说怎么跑得起来。
  (b) GUIDE 原文写着「`python_exec`/`python_check`/`regex`/`citation` need `prove.positive` from you」
      —— 照这句话做，必然撞上 (a)。README 里同样有一句「still need `prove.positive` from the caller」。
修复：(a) proofWhy 把「调用方提供的 positive 被接受」单独分出来，直说 ACCEPTED、任务被拒而非被花掉、
      并给出出路：**这类门不要传 `prove`**（不传就是「未证明但能用」）。
      (b) GUIDE 改成 **DO NOT pass `prove` on python_exec/python_check/regex/citation**，README 同步纠正。
证据：修后新字节同一条调用返回「…was ACCEPTED — that is expected, not a defect, and the task is
      refused rather than spent. Drop `prove` for this kind…」；不带 prove 的同一个 regex 任务 PASS（2.1 s）。
诚实边界：**这是文案与 GUIDE 的修复，不是语义变更**——这四类门依然无法被 prove 认证、依然拒绝执行
      （上一轮 §6 第 6 条与此一致）。想让它们「证明后仍执行」是另一个设计决定，本轮**没做**。
```

### 7. 变异证明（两条修复各自有牙齿）

在 **junction 之外的临时拷贝**里做，仓库文件没被碰（脚本：`%TEMP%\ld-mutate.py`）：

| 变异 | 期望 | 实测 |
|---|---|---|
| M1 去掉 `asserts` 的行首 `assert` 剥离 | 恰好 1 条自检失败 | ✅ `198 passed, 1 failed`，失败的就是那条两者写法都要过的 |
| M2 关掉 proofWhy 的「调用方 positive 被接受」分支（回到旧文案） | 恰好 1 条失败 | ✅ `198 passed, 1 failed`，失败的就是 ACCEPTED 那条 |
| M3 GUIDE 恢复旧的「need `prove.positive` from you」 | 恰好 1 条失败 | ✅ `198 passed, 1 failed`，失败的就是 GUIDE 那条 |

本轮自检 **195 → 199**（+4：`asserts` 两种写法、假断言仍失败、ACCEPTED 文案、GUIDE 不再误导）。

### 8. 生效条件（**重要**）

改了 **3 个文件**（`local-delegate.mjs` / `local-delegate.selftest.mjs` / `README.md`），已
`sync-install`（3 个 `copied`，随后 `--check` up to date）。**但本会话内存里仍是旧模块实例**
（0.6/0.12 的教训：模块每进程加载一次），所以：

- 本轮**无法**用 `delegate_batch` 端到端复现两个修复 —— 那不是漏做，是环境决定的；
  上面对新字节的验证是**独立 node 进程**里做的（同一条代码路径，不走 cordis 管道）。
- 要让修复真正在会话里生效：**重启 DSH 本身**，然后先跑 0.6 的行为探针确认模块身份，
  再重跑缺陷 1 / 缺陷 2 的原始形状（都应从 FAIL 变成「语句写法 PASS」和「拒了但文案给出出路」）。

**重启后的验收（用户已重启，2026-10-13 21:33:35 起的进程；模块 21:31:48 写盘 → 进程晚于模块）**：
三项全部按预测发生，两个修复**在真实会话里端到端生效**。

| 项 | 形状 | 实测 |
|---|---|---|
| 缺陷 1（本版**专用**的身份探针） | `python_exec`，`asserts: ["assert double(21) == 42"]`（完整语句） | ✅ **PASS**（2.1 s）——上一版必然是 `assert (assert …)` 的 SyntaxError |
| 缺陷 2（同上，探文案） | `regex` + `prove: {positive:"2026-10-13"}` | ✅ 被拒，且文案是新的：`…even though your positive example was ACCEPTED … Drop `prove` for this kind…`（旧版会说 "cannot be derived"） |
| 无连带回归 | `covers` + **`prove: true`**（可派生的类） | ✅ 先证后跑，`all 3 covered`（2.3 s） |
| 无连带回归 | 多步算术 `exact` | ✅ `got="120"`（2.4 s）→ `low` 仍生效 |
| 视觉链路 | `img-plain.png` + `all_of` | ✅ `all 2 found`（2.4 s）——上一轮生成的夹具还在 `%TEMP%\vision-fixtures\` |
| 磁盘侧 | `node local-delegate.selftest.mjs` | ✅ **199 / 0**；源码 ⇄ 安装副本指纹一致 |

> ⚠️ **给下一轮的方法论更正**：0.6 那条「不带 `retries` 的必 FAIL 任务」探针只能区分
> 「中间坏版本（默认 1）」与「磁盘版本（默认 0）」，**它区分不出本版与上一版**（两版都是默认 0）。
> 要判定**这一版**是否在跑，用上表前两行（完整语句写法必须 PASS；`prove` 的拒绝文案必须带 `ACCEPTED` 与
> `Drop `prove``）。**每次改模块后，都要给这一版留一条自己的身份探针**，否则"探针通过"会被误读成"新代码在跑"。

### 9. 指纹（源码 = 安装副本，逐个用 SHA256 核对）

| 文件 | SHA256(16) | 字节 |
|---|---|---:|
| `local-delegate.mjs` | `BA8A85C195A69DFB`（`774056C353067B3D` ← `A21E2B31F686E714` ← `60B3D4DE55512D8A`） | 111,375 |
| `local-delegate.selftest.mjs` | `44C003FBF4D76F71`（`EAE5AA668FEC0152` ← `E4BBC95796C558FC` ← `408E4DB99467824A`） | 66,563 |
| `README.md` | `26A54132B89BA373`（`DCDE160DD4126683` ← `E97A31E53762B133` ← `12CC6A0E9039EEB3`） | 76,149 |

三个文件**源码与安装副本逐字节一致**。`cordis.patch.yml` 未改，仍是 `E52A9FEB360C4D38`（9,134 B，
`build --check` up to date）。

### 10. 仍然开着的 / 下次可直接复用的

- **显卡 #779 提示**（0.1.43.1）：本机显卡同时驱动显示器，若加载后画面冻结/黑屏，用
  `--vram-reserve-mib 1500` 重跑 setup。本轮**没有**出现冻结。
- **长上下文**：可靠范围 ≤142K、145K 是不稳定区、231K 必失败；**委派 prompt 控制在 128K 以内**（上一轮实测）。
- **`subagent` 无法从子代理手里拿走**（本插件做不到，只有 harness 能），只靠 120 s 预算兜底 —— 这是**结论**，不是待验项。
- **重建视觉夹具**（上一轮的 5 张已被系统清理），一条命令即可：

  ```powershell
  $py = "C:\Users\14339\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
  # PIL 画 640x480 白底 + C:/Windows/Fonts/arial.ttf 44px 两行字 → $env:TEMP\vision-fixtures\img-plain.png
  ```

  然后 `delegate_batch` 带 `images: ["<绝对路径>"]` + `verify: {kind:"all_of", expected:["MEN WALK ON MOON","SAMPLE 42 DELTA"]}`。

### 11. 「领导模式」SOP 已写进 GUIDE（用户点名要求）

**加了什么**：GUIDE 里新增一条 **LEADER MODE**（970 字符），把此前散在十几条 bullet 里的工具契约收成一个**操作循环**：
拆成「每步都以一个可机器判定的结论收尾」→ **先写判据再派**（写判据就是"你理解了这一步"的证明；若写判据比做这一步还贵，就直接做）→
派（`delegate_batch` 文本进文本出；要在文件里读、要看图的步骤走 `subagent`）→ **判决和载荷一起读**（PASS 只覆盖判据问过的部分）→
FAIL 就**改点什么**（拆小、换问法、自己做），不要重发。同一条里写了两件事：citation 门的**天花板**
（它验证的是**证据而非推论**——引用为真不等于结论成立，实测 2026-10-13：5 条引用全部成立，其中一条 claim 并不由它引的那行推出）；
以及**三件不外放**的事（判据本身、跨文件因果/多步推理、用户要读的那句话）。

**为什么放 GUIDE**：GUIDE 只给顶层、每轮重新求值，子代理拿不到；而「决策指挥」正是**子代理绝不该听到**的话
（它的使命是 `you are the executor`）。这条差异被自检从**两个方向**钉住。

**代价（诚实记账）**：GUIDE **10,517 → 11,390 字符**（净 +873；LEADER MODE 本身 970，同时把 LARGE JOB 那条里重复的半句删了 97）。
按本 README 已记录的 ~4.09 字符/token 换算约 **+213 token**，即顶层每次请求多付约 210 token。
**字符数是实测**（渲染出来的 section 文本），**token 数是换算、未重新实测**（要引擎侧 `usage.prompt_tokens` 才能实测）。
CHILD_GUIDE 未动，仍是 625 字符。

**自检 199 → 201**，两条新钉：顶层 GUIDE 必须含这个循环；**子代理必须拿不到它**（且其自己的文案里要有 `executor`）。
**变异证明**：M4 把 `LEADER MODE` 改名 → **恰好 1 条**失败（新钉）；M5 让子代理谓词失效（子代理拿到全量 GUIDE）→ **5 条**失败，
其中包含这条新钉 —— 说明它同时守住了「不许漏给子代理」这个方向。

**生效条件**：这是 **GUIDE 文本**（prompt section），按 0.6 的实测**每轮重新求值**，所以**不需要重启**，
下一轮顶层提示里就应出现 `LEADER MODE`；这与「改工具要重启」是两回事（**GUIDE 变了 ≠ 工具变了**，反之亦然）。
**本轮无法在同一轮内自证**（我读不到本轮的 system prompt）。判据：下一轮的顶层提示里出现 `LEADER MODE`；
若没出现，说明这条不成立，按工具变更处理（重启），并把结论写回这里。

### 12. 形状账本写进 GUIDE + README（用户点名要求），以及一次真实项目分析的实测

**第一次真正拿一个外部项目做的实测**：`C:\Users\14339\Desktop\git\dsh-session-sync`
（DSH 的多机会话同步插件；基线 **35 文件 / 478,230 字节**）。做法：**我只列目录、只 grep 判据**，
源码内容一律由本地模型读 —— 这正是「领导模式」的字面执行。

**账本（本地侧是引擎日志精确值；我这一侧按字符估算）**

| 项 | 值 |
|---|---|
| 本地请求数 | 5（1 个 `delegate_batch` 误用 + 2 个 `subagent` 各自多步 + 复用） |
| 本地 prompt token（含前缀复用） | **111,684** |
| 其中新预填 | 66,445 |
| 其中**项目内容** | **47,752** token = **132,793 字节 @ 2.78 字符/token**（TS/JSON 比散文密） |
| 本地生成 | 3,344 token |
| 墙钟 / API token | **24.9 s / 0** |
| 我这一侧（派发 + 判决 + 收结果） | **≈1,850 token**（≈6,500 字符） |

**节省率**：口径 A（同样这份分析，不委派要读 132.8 KB ≈ 47.8K token）→ **≈96.0%**；
口径 B（分析整个项目 478 KB ≈ 172K token）→ **≈98.3%**。

**两个真实发现（都写进文档了）**

1. **`delegate_batch` 的子代理没有工具，我却让它"去读五个文件"** → 它回
   `I cannot read files … I will not invent symbol names` + `[]`，`covers` 门如实报 **41/41 missing**。
   模型拒绝幻觉、门有牙齿 —— 代价只有 6 s 本地算力，但**这次派发报废**。改成 `subagent` 一次 PASS
   （41 个符号，`set_eq` 精确通过）。
2. **`subagent` 的答案要经我手两次**：`verify_task` 要求把答案**贴回**工具调用，于是它进我上下文两次
   （这次 ~1,500 字符）。`delegate_batch` 插件内部验、**零回贴**。所以形状选择有了经济依据：
   **纯文本派 `delegate_batch`（固定前缀 2.4K）；要读文件才用 `subagent`（固定前缀 15.3K），且要求答案紧凑**。

**落地的两处改动**

- **GUIDE**：在 `WHEN THE LOCAL MODEL NEEDS TOOLS` 那条末尾追加一句（~415 字符）：
  `MEASURED SHAPE COST: ~2.4K vs ~15.3K … a subagent answer must be handed BACK into verify_task … crosses your context twice … Never hand a delegate_batch task a path to open`。
  GUIDE **11,390 → 11,805 字符**（换算 ≈2,887 token，顶层每次请求多付 ~100 token）。
- **README**：prompt-token 那节新增一条完整账本（含上表、两个节省率口径、以及"省的是钱和上下文，不是时间"）。

**自检 201 → 202**（+1 条：GUIDE 必须含那三个事实），
**变异**：三个事实各自被单独守住（改任一句 → 恰好 1 条失败）。
⚠️ **诚实记录一次失败的变异**：第一版 M6 改的是标题（`MEASURED SHAPE COST:` → `SHAPE COST:`）→ **存活**。
不是钉子有洞（它钉的是三个事实，标题没有语义），而是**变异选错了目标**；重做为三处事实变异后全部被抓。
教训：**变异要落在断言真正覆盖的东西上**，否则"存活"会误导成"钉子没牙"。

**一个副作用值得记**：顺带独立复核了项目里 `build/function-index/verification-report.json` 的
`expected 384 / reported 384 / matched 384 / missing 0 / verdict true`（22 个文件）——citation 只证"引文为真"，
这条是用 `ConvertFrom-Json` **另做的真验证**，代价 15 行输出而不是 4.7 KB 文件。
**这正是「grounded ≠ true」那句话的正面用法：引文真，再补一次便宜的确定性检查。**

### 13. 增强落地（用户批准：P1 → P3 → P4断言 → P2，顺手 P5/P6）

**改了 `local-delegate.mjs` 五处**（都带自检与变异证明）：

| # | 改动 | 关键设计点 |
|---|---|---|
| **P1** | `delegate_batch` 任务支持 **`files: [paths]`** | 插件读文本文件，内联进**同一个 text block**（新块类型会撞适配器的静默 `default: break`，这是 `inspectImages` 注释里那个坑）。上限 `DSH_DELEGATE_FILE_CHARS`（默认 200,000 字符 ≈ 72K token @2.78 字符/token，落在 ≤142K 可靠区内），**每次调用读**（照 `childBudgetMs` 的理由）。坏路径 = 该任务 FAIL **+ 不重试 + 不影响后续任务**（与坏图片路径同一契约）。 |
| **P3** | **本地 token 账本**（逐任务 + 批次 footer） | `SubagentResult` **没有** usage 字段（运行构建声明只有 `output`/`structured`/`diagnostic`/`stopReason`），所以取引擎自己的 `/metrics.totals` 前后差。报 `N local tokens (P prompt: R read + U reused; G generated) · 0 API tokens`。**缺失或引擎重启（计数减少）→ 整行不出现，绝不猜**。读取器可注入（`setEngineTotalsReader`）——自检必须密闭，已默认注入 `() => null`。 |
| **P2** | `verify_task` 支持 **`contentFile`** | 消掉「答案回贴」税；`contentFile` **优先于** `content`，两者不会静默打架；不可读/超限都是指名的 FAIL。 |
| **P4** | **GUIDE / CHILD_GUIDE 体量预算断言** | 13,000 / 1,200 字符。今天 GUIDE 曾两次无闸增长（+873、+415）。 |
| **P5** | 每任务 **`timeoutMs`** 覆盖全局预算 | 之前只有全局 env，一批里没法给慢任务更多时间。 |

**自检 202 → 226**（+24 条，一次全过）。**变异 8/8 被抓**：M1 分隔符 / M2 fileError 契约 / M3 上限 / M4 减少保护 / M5 账本挂载 / M6 contentFile / M7 每任务预算 / M8 footer 账目。
⚠️ **M2 第一次是"套件崩掉"而非"具名失败"**（那条断言没包 try/catch）→ 已按本仓库「verifier 异常曾整批 abort」的教训改成具名断言，复跑得到具名 FAIL。
**教训：变异要落在断言真正覆盖的东西上；"崩掉"虽然也算被抓，比具名失败少一层信息。**

**GUIDE 里那条规则被本次改动作废了，已同步改写**：`Never hand a delegate_batch task a path to open` →
`NEVER paste a file into prompt yourself … use files: [..]`。GUIDE 11,805 → **12,237 字符**（预算 13,000，余 763）。

### 14. P6 实测：前缀缓存在**一次子运行内**成立、**跨运行不成立**（更正上一轮的一句话）

| 观察 | 数字 |
|---|---|
| 两个**逐字节相同**的 prompt 背靠背（同批两个任务） | **两次都是 `reused=0`**（各 2,342 prompt / 2,342 read） |
| 两个共享 ~2.3K 前缀、只有尾巴不同的任务 | 同样 `reused=0` |
| **同一个子运行**的第 2 步 | `prompt 16,597 = 15,327 reused + 1,270 read` ← 复用是真的 |

机制：`/metrics` 报 `conversation_cache.enabled: false`、`budget_mib: 0`，因为 `min_free_mib: 2560` 对 `vram_free_mib: 225`
—— **跨会话缓存被显存饿死**，不是预设配错。两个可操作结论：**(a)** 每个同批任务都付完整固定前缀（~2.4K ≈ 1.2 s 预填），
所以**把小任务合并成更大的任务比拆开更省**；**(b)** 多步子代理每步只重读增量，15.3K 工具前缀不是每步成本。
**这更正了上一轮 §4 那句「引擎有 prompt cache——同一 prompt 第二次发只需 0.2 s」**：那是运行内、或缓存开启时的观察，不是跨请求通则。

**独立进程实读**（不是测试桩）：`readEngineTotals()` 对真引擎返回 `{"prompt":21677,"reused":0,"generated":134}`；
`inspectFiles` 对真文件返回 `{"n":"package.json","chars":936}`。**注意引擎在本轮中途重启过**（totals.requests 从 106 归 4）——这正是 `tokenDelta` 的减少保护存在的理由。

### 15. 生效条件（本轮与上一轮不同，别混）

`files:` / 账本 / `contentFile` / 每任务 `timeoutMs` 都是**工具行为**，**必须重启 DSH** 才在会话里可用；
而 GUIDE 里那几句说明是 **prompt section、下一轮就出现**。**两者不同步——不要用 GUIDE 判断工具是否生效**（0.6 的老教训）。

**重启后的验收配方**（三条，都应过）：
1. **账本**：任一 `delegate_batch` → footer 出现 `N local tokens (… ) · 0 API tokens`。
2. **`files:`**：`{ tasks: [{ description: "inline-probe", prompt: "count the exports", files: ["<某个 .ts>"], verify: { kind: "contains", expected: "export" } }] }` → PASS，且**我不需要把文件内容贴进 prompt**。
3. **`contentFile`**：把任一 >500 字符的答案写进文件，`verify_task { kind: "count", expected: "N", contentFile: "<path>" }` → PASS。

> **判定本版字节在跑**：0.6 那条「默认 0」的探针**已区分不出本版**（上一版也是 0）。用**账本**判定：
> 重启后第一次委派的 footer **必须带 token 账目**，旧版永远没有这一行。

**重启后验收：三条配方全部通过（已完成）**

| # | 配方 | 实测 |
|---|---|---|
| 1 | **账本** | 两个任务的 footer：`— 2/2 PASS · 8.1 s of local compute · 10,252 local tokens (9,937 prompt: 9,937 read + 0 reused; 315 generated) · 0 API tokens`。**与引擎原始计数器逐位吻合**：`/metrics` 里那两次请求是 `prompt=7594 gen=269` 与 `prompt=2343 gen=46`，合计正是 9,937 / 315。**这就是本版字节的身份判据**（旧版 footer 不可能有这一行）。 |
| 2 | **`files:`** | 我**没有**把 `dsh-session-sync/src/host/transport.ts`（19.6 KB）贴进 prompt，只给了路径；`covers` 6 个 needle（早先 grep 机器取得）**全中**，任务行 `7,594+269 tok`。 |
| 3 | **`contentFile`** | 子代理用 `write` 把答案写进 `%TEMP%\ld-accept-20261013.json`（595 B），我用 `{kind:"covers", contentFile: 路径}` → **all 29 covered**；再用 `set_eq` 判**同一条路径** → **PASS**（精确集合，无多报）。**答案全程没有进我的上下文**，我只看到判决。 |

**顺带被独立印证的两条**：

- **§14 的前缀复用**：该子代理三步的 `reused` = **0 / 15,649 / 20,514** —— 首次冷启不复用，运行内每一步都复用前一步前缀；
  11.8 KB 的文件进了**子代理**的上下文，没进我的。
- **单侧门 vs 精确门**：配方 1 那次 `covers` **放过了多报的 `"Server"`**（`covers` 只判漏报），而同一份答案用 `set_eq` 就会抓住它。
  **要"没有多余项"，必须用 `set_eq`/`subset_of`，不能用 `covers`** —— 这条 §6 第 1、2 条早写了，这次是撞在自己身上的实证。

**本轮指纹**（源码 = 安装副本）：`local-delegate.mjs` `D98C684112B9306F`（123,771 B）·
`local-delegate.selftest.mjs` `0AB2105AE67182E8`（79,711 B）· `README.md` `2FAA234F4379236D`（79,803 B）。
`cordis.patch.yml` 未改（`E52A9FEB360C4D38`）。回归门全绿：`node --check` ×2 · **226 / 0** · sync up to date ·
`build --check` up to date · bundle `valid` · roster `OK: 5 presets`（`allows-local=25 / dead-route=150`，会话数 257）。

### 16. 中文主说明（`README.zh-CN.md`）重写为权威用法文档

**为什么重写而不是补**：那份是当天 21:10 的「精简版」，**它的红线 #1 已被本轮改动作废**——
它写着"读原料型任务必须走 `subagent`，因为 `delegate_batch` 要内联、约等于 2× 基线的倒亏"，而 `files:` 正是为消除这条倒亏加的。
一份**把已修好的限制当成红线**的主说明，比没有主说明更坏。

**现在的分工**（写进三份文档的开头，避免再有人读到过期那份）：

| 文件 | 定位 |
|---|---|
| `README.zh-CN.md` | **中文主说明（权威用法）**：契约、接口、判据、边界、运维、14 节 |
| `README.md` | 英文完整版，保留**全部测量叙事与出处**（顶部新增指向中文主说明的导引） |
| `NEXT-SESSION.md` | 交接单：开发过程、未决项、指纹 |

**随包同步**：`sync-install.mjs` 的 `FILES` 从 5 个变 **6 个**（新增 `README.zh-CN.md`），
`package.json` 的 `files` 从 `README.md` 改为 **`README*.md`**。安装副本现存两份文档（`README.md` 80,093 B / `README.zh-CN.md` 22,370 B）。

**自检 226 → 228**，两条新钉（**主说明与英文 README 同一契约**）：
文档必须**点名全部 16 个 kind**；必须同时含**「GUIDE 变了 ≠ 工具变了」的生效规则**、**`files:` 形状规则（`DSH_DELEGATE_FILE_CHARS`）**、**token 账本（`0 API tokens`）**。

**变异**：M2 删 `files:` 规则、M3 删账本句 → **各自恰好 1 条具名失败**。
⚠️ **M1 又一次"存活"了**，原因同上次：`union_eq` 在文档里出现 **2 次**，而我只替换了第一处。
**全局替换后立刻抓到**（`the Chinese main document names every kind too ? union_eq`）。
**教训（第二次撞同一块石头）：变异必须真的删净断言覆盖的东西——"替换一处"不等于"删掉这个事实"。**

**不需要重启**：本轮改的是**文档 + 打包元数据**（`package.json` 的 `files` 只影响 npm 打包，不参与模块解析），
模块行为一行未动（`local-delegate.mjs` 指纹仍是 `D98C684112B9306F`）。**GUIDE 也没有改**，所以下一轮提示词也不变。

**新指纹**：`local-delegate.selftest.mjs` `31F3EF057D59B675`（80,942 B）· `README.md` `1DB95085F4A6264D`（80,093 B）·
`README.zh-CN.md` `193EB596D7AC57E7`（22,370 B）· `package.json` `7B33A76F0AFCBC5D`（726 B）·
`scripts/sync-install.mjs` `DF9A1FF303F457B5`（3,150 B）。自检 **228 / 0**，sync up to date，roster `OK: 5 presets`。

### 17. 「主」落到**文件名**上：`README.md` = 中文主说明，英文退为 `README.en.md`

§16 只是把中文那份**内容**写成主说明，但文件名仍叫 `README.zh-CN.md`——那名字本身就在说"这是个译本/变体"，
而 `README.md` 才是任何工具、任何人在目录里第一眼打开的那份。本节把这件事做实：

| 之前 | 之后 |
|---|---|
| `README.md` = 英文完整版 | **`README.en.md`** = 英文完整版（保留全部测量叙事与出处） |
| `README.zh-CN.md` = 中文主说明 | **`README.md`** = **中文主说明**（22,364 B，14 节） |

**做法与引用更新**：文件用**移动**完成（没有把 80 KB 读进上下文）；改了 5 处引用——
`sync-install.mjs` 的 `FILES`、模块头两条注释（"see README.en.md for … the sources"）、两份文档开头互相指向的导引、以及自检的读文件路径。
`package.json` 的 `files: ["README*.md"]` 本来就覆盖两者，未改。

> ⚠️ **`sync-install` 只复制、不删除**：安装副本里于是留着一份**过期的 `README.zh-CN.md`（旧的中文精简版）**。
> 已**先解析绝对路径、确认不是 reparse point**，再单独删掉；现在安装副本里是 `README.md` 22,364 B + `README.en.md` 80,101 B，与源码一一对应。
> **下次重命名/下线文件时要记住这条**：同步工具不认识"删除"。

**自检 228 → 229**，四条钉子（**两份文档同一契约，且指向不许交叉**）：
主说明必须点名全部 16 个 kind；英文版同样必须；**主说明**必须含那三条规则（GUIDE vs 工具、`files:`、token 账本）；
**两份文档的互相指向必须用新名字**（`README.en.md` / `主说明`），且**不许再出现 `README.zh-CN`**，并附带一条绊线
（`主说明.length < 英文版.length` —— 中文主说明是提炼版，一旦比英文版还长，说明"交换没生效"或"主说明该拆了"，
**这是一条提醒，不是正确性断言**）。

**变异**：M1 把英文版指回旧名 → **抓到**。⚠️ **M2、M3 第一轮"存活"，又是我变异写弱**：
- **M2**：`主说明` 在英文文档里出现 **2 次**，我只替换了一处——**这是我第三次犯同一个错**（前两次见 §13/§16 的教训）。
  改成**全局替换**后立刻抓到。**机械规则：变异必须删净所有出现，不是替换第一处。**
- **M3**：我垫了 60,000 字符以为够了，但比的是 JS `.length` 而**不是字节数**：主说明 `.length` 只有 **13,159**（中文 3 字节/字），
  英文版 **79,260**。垫到 +150,000 后抓到。**教训：比较长度前先量真实长度，并按比较的单位（UTF-16 单元）构造变异。**

**不需要重启**：本轮只动了文档、注释、`sync-install.mjs` 与自检（`package.json` 未变）。
`local-delegate.mjs` 改了**注释**——指纹变了（`D98C684112B9306F` → `B923A7B54AF07CEE`，123,820 B），
但**代码一行未动、GUIDE 一字未改**，所以运行行为与提示词都不变，无需重启、下一轮提示词也不变。

**新指纹**：`local-delegate.mjs` `B923A7B54AF07CEE`（123,820 B）· `local-delegate.selftest.mjs` `4978CE617670F482`（81,727 B）·
`README.md` `9315A055E8B4ABB7`（22,364 B）· `README.en.md` `7C09BD44C5E45A7F`（80,101 B）·
`package.json` `7B33A76F0AFCBC5D`（未变）· `scripts/sync-install.mjs` `10194AED8529DBC1`（3,147 B）。

**顺手核对的一条异常**：`profiles\desktop\bundles\dsh-preset-hybrid\` 这个目录**又出现在磁盘上**，但它是
**空目录（0 文件）、时间戳 2026-10-02 19:30**，且 **roster 里没有 hybrid**（仍是 5 行）。所以它是不参与加载的残留，**不是 hybrid 复活**——
0.11 那次删除删掉了文件，空壳留了下来。记在这里，免得下一个人看到目录就以为预设回来了。

### 18. 首次发布：`v1.0.0`（推送 + 标签 + GitHub Release）

**结果**：`main` 推到 `6626d56`，附注标签 `v1.0.0`，Release 已发布（非草稿、非预发布）——
<https://github.com/cczzyy-cn/dsh-preset-local-delegate/releases/tag/v1.0.0>。发布说明 2,344 字（中文）。

**标签为什么是 `v1.0.0`**：仓库**没有任何版本惯例**——无标签、无版本/发布类提交，文档里的"0.5～0.18"是**交接单的轮次编号**，
不是发布版本（唯一的外部版本号是 DSH 的 `dsh-v0.1.7-rc.2` 与引擎的 `v0.1.43.1`）。唯一自称的版本是 `package.json` 的 `1.0.0`，所以用它。
**若用户想换成别的号**：`git tag -d v1.0.0` → `git push origin :refs/tags/v1.0.0` → 删掉 Release（API `DELETE /releases/<id>`）→ 重打。**代价不大，但别在别人拉过之后改。**

**这台机器发 Release 的三个环境事实（下次直接用，不必再摸）**：

1. **GitHub 直连会被 reset** → git 已配 `http.proxy=http://127.0.0.1:10808`（与系统代理同址），`git ls-remote` 1 秒通；`git push` 也是这条路。
2. **`gh` CLI 未安装** → Release 只能走 **REST API**（`POST /repos/<owner>/<repo>/releases`）。
3. **凭证从 git 自己的 helper 取**，不要向用户要 PAT：
   ```powershell
   $cred = "protocol=https`nhost=github.com`n`n" | git credential fill
   $token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=',''
   # 本机实测：user=cczzyy-cn、type=OAuth、length=40 → Invoke-RestMethod -Headers @{Authorization="Bearer $token"} 可用
   ```
   **token 只进内存、不进 argv、不打印**（`Invoke-RestMethod` 的 header 哈希表不会出现在进程命令行里）。
   API 调用要显式 `-Proxy http://127.0.0.1:10808`，否则同样被 reset。

**一条完整的发布配方**（本轮就是这么做的）：

```powershell
cd dsh-preset-local-delegate
git add -A; git status --short          # 先看清提交什么（本轮 8 个文件）
git commit -F <消息文件>                 # 一个提交：自检里功能钉子与文档钉子同文件，拆开会让中间提交变红
node local-delegate.selftest.mjs        # 该提交必须自检全绿（本轮 229/0），否则标签会指向一个红提交
git tag -a v1.0.0 -m "…"
git push origin main; git push origin v1.0.0
# 然后用 REST API 发 Release（见上），最后匿名复核：GET /releases/tags/v1.0.0 + ls-remote 比对
```

**发布后的独立复核**（都做了）：匿名 `GET /releases/tags/v1.0.0` → `draft=False`、`prerelease=False`、`body` 2,344 字；
`git ls-remote` 的 `refs/heads/main` 与本地 HEAD 同为 `6626d56`，`refs/tags/v1.0.0` 为 `b29b04f`（附注标签对象）；工作区干净。

> **一条只提一次、不阻塞的观察**：仓库是**公开**的，而文档里有 `C:\Users\14339\…` 这类**绝对路径**（历史提交里也有）。
> 想脱敏就批量替换成 `%USERPROFILE%` / `<profile>`——本轮没做，因为那是全仓改动、且不属于本次要发的功能。

---

## 上一轮（2026-10-13）：引擎/模型换代，以及两个真缺陷

> **本节优先于下面所有 0.x 记录。** 0.x 写的是 10-02 那轮（coder 模型 + 引擎 0.1.35）的事，
> 事实仍有效，但**当前机器上的版本已经完全换了**。读这一节就能开工。

### 0. 当前状态（2026-10-13，逐项实测过）

| 层 | 值 | 怎么确认 |
|---|---|---|
| Strata 源码 | `a0116b27` = **v0.1.43.1** | `git -C <strata> log --oneline -1` |
| 引擎 | `engine/BUILD.json` = **0.1.43.1** | 引擎日志会自报 `session is up (engine 0.1.43.1)` |
| 模型 | **qwen3.8-flash-next-iq2_xs**（2-bit 通用，数据在 **D:** 盘） | `curl http://127.0.0.1:8080/health` |
| 引擎窗口 | **262144**，KV int8，`--kv-resident 32768`，images on | 同上 |
| 推理档位 | **`low`**（引擎 shared default，`strata-iq2_xs.shared-settings.json`） | `curl http://127.0.0.1:8080/settings` |
| DSH 路由 | `strata/qwen3.8-flash-next-iq2_xs`，`contextWindow 262144` / `maxTokens 8192` | `list_subagent_models provider=strata` |
| preset | 源码 ⇄ 安装副本**已同步**，selftest **195 / 0** | `node scripts/sync-install.mjs --check` |

**注意**：`coder-IQ1_M` 已被**删除**（用户要求）。任何还写着 `qwen3.8-flash-next-coder-iq1_m` 的
地方都是**过时残留**，它不再存在于引擎里。

### 1. 本轮动了什么

1. **Strata 从 0.1.29 提到 0.1.43.1**。中途差点被坑：本机上 GitHub 直连会被 reset，而 setup 的
   `urllib` 读的是**系统代理**；系统代理关着时它超时，于是 setup 判定"没有现成引擎"、**转去下载并安装
   CUDA Toolkit 13.0（8-10 GB）**。我及时终止，CUDA **没有被安装**。正确做法是**手动把 release 里的
   `strata-windows-x64.zip` 解到 `engine/`**（`tar -xf`）。
2. **换模型**：coder-IQ1_M（32 GB 档）→ **qwen IQ2_XS**（48 GB 档），因为本机内存升到了 70 GB。
   下载 68 GB 时 setup 自带的下载器实测只有 **17 KB/s**（同一代理下 curl 是 **28 MB/s**，差三个数量级），
   所以最终用 `curl` 下载、写成 `.part`、再让 setup 校验收尾。
3. **推理档位从 `none` 改为 `low`**，理由见下面的坑 B。
4. **preset 侧**：GUIDE 里那句"Thinking buys nothing here / 已经是 `none`"已重写为以**正确性**为由跑
   `low`；两份 README 的模型 id 同步；`LOCAL_MODEL` 默认值改为新模型名。
5. **两份 README 顶部加了 `[!IMPORTANT]` 告示块**，写的就是坑 A。

### 2. 两个必须知道的坑（本轮各踩了一次）

**坑 A —— `sync-install.mjs`：「我重新装过了」这句话会骗你。**
preset 是以 `file:` 目录依赖装进 `<profile>/node_modules/dsh-preset-local-delegate/` 的，而 pnpm 按键控
**manifest** 而不是内容。所以改完 `local-delegate.mjs` 再"重新安装"，它会打印 `Already up to date`，
而 harness 跑的还是**旧模块**。本轮后果：`LOCAL_MODEL` 默认值仍是已删除的 coder 模型名，与 provider 的
模型列表不匹配，于是**每一次委派都在 23 ms 内被拒**：

```
child LLM route "strata/qwen3.8-flash-next-iq2_xs" is not allowed for this Session
```

**动作**：改完 preset 后
```bash
node scripts/sync-install.mjs --check   # 退出码 1 = 线上副本是旧的
node scripts/sync-install.mjs           # 复制并逐文件报告
```
然后**重启 DSH 本体**——同进程里开新会话会复用已加载的模块实例，**"我开了个新会话"不算重启**。

**坑 B —— `reasoning_effort` 不是速度问题，是**对错**问题。**
`none` 下模型做多步算术会**静默答错**（"120 件，先卖 1/3，再卖剩余的 1/4，再进 60"→ 答 `100`，
正确答案 `120`；只生成 4 个 token，**看不出任何犹豫**）。`low` 就答对（104 token，1.0 s）。
`low` / `medium` / `high` 在延迟和正确率上**无法区分**，所以真正的选择只有 `none` 与 `low`+ 两档。
简单任务（抽取、JSON、代码、读图）**各档都对**，所以这个设置约 +0.7 s、~100 token/次，
只在多步推理上有回报。**不要为了快把它调回 `none`。**

### 3. 已知未决项

- **`subagent` 工具在本会话被拒**（`delegate_batch` 不受影响，一切正常）。根因是**会话级**快照
  `subagentModelSelectionPolicy` 仍是旧模型名：
  ```json
  "subagentModelSelectionPolicy": { "val": [ {"provider":"strata",
                                              "model":"qwen3.8-flash-next-coder-iq1_m"} ] }
  ```
  它存在于**父会话**里（`seq` 很大），**子会话继承**它。profile patch 的 `allowedModels` **已经是新名**
  （已核对），但**会话快照跨重启保留**。→ **新开一个主会话应该就能用 `subagent`**；本会话内它始终用旧值。
- **0.1.43.1 带来的 #779 提示**：本机显卡同时驱动显示器，若加载后**画面冻结/黑屏**，用
  `--vram-reserve-mib 1500` 重跑 setup。
- 长上下文实测边界（见第 4 节）：**> ~145K token 会静默崩塌，> 230K 必失败**，
  虽然配置允许 262144。

### 4. 长上下文实测（IQ2_XS @ 256K，用真实文档做的针测试）

| prompt token | 结果 |
|---|---|
| 6K / 29K / 60K / 115K / 122K / 129K / 133K / 138K / 142K | ✅ 全部找到（含多针区分） |
| **145K** | ⚠️ 一次失败、一次成功 → **不稳定区** |
| 154K | ✅（单次） |
| **231K** | ❌ 2/2 失败 |

**失败模式要注意**：越界后不是"找不到针"，而是**指令跟随整体崩塌**（开始说无关的话，甚至答
`I can help with the A770`），**输出还会撞满 max_tokens**。所以不能靠"答案看起来合理"判断它是否还在状态。
**结论：可靠范围 ≤ 142K，实际使用请把委派 prompt 控制在 128K 以内。**

**附赠发现**：引擎有 **prompt cache**——同一 prompt 第二次发只需 **0.2 s**（首次 47 s），所以对同一份长
文档连续问多个问题，只有第一次要付时间。另外长 prompt 的处理速率反而更高（~2,600–3,000 tok/s）。

### 5. 新会话开头的三条自检

```powershell
curl.exe -sS --noproxy "*" "http://127.0.0.1:8080/health"   # 模型/窗口/loaded
node scripts/sync-install.mjs --check                        # preset 副本是否同步（exit 1 = 旧）
node local-delegate.selftest.mjs                             # 期望 195 passed, 0 failed
```

### 6. 门配对的 7 个坑（本轮实测，全部是我自己踩的）

1. **`subset_of` 不保证完整**——空数组也满足它。"没有多余项" ≠ "没有遗漏"。
2. **`set_eq` 不管重复**——要防重复必须用 `python_check`（`len(a) == len(set(a))`）。
3. **`all_of` 是「且」不是「或」**——`"正方形|矩形"` 永远无法满足；要「或」请用 `regex`。
4. **`regex` 不支持 `(?i)`**（JS 风格）→ `Invalid group`。
5. **`regex`/`python_exec`/`python_check`/`citation` 的 `prove` 必须自带 `prove.positive`**，
   否则报 `no positive example`。
6. **`python_check` 根本无法 `prove`**（无结构变异算子）→ 只能**手工验证**；插件会明说这是
   expected、不是缺陷。
7. **`covers` 的 needles 要宽容近义词**——模型写「**售价** 899 元」而 needle 是「价格」就会误判。

**另外**：1、2、6 这几种门**插件会主动拒绝执行**（`gate has no power`），**不会浪费一次委派**——
这正是 `prove` 的价值，不要因为被拒就去掉它。

### 7. 本轮实测通过的任务形状（可放心委派）

抽取·分类/划分（`union_eq`）·摘要（`covers`）·翻译·格式化（`regex`）·可执行代码（`python_exec`）·
多步算术（`exact`，需 `low`）·计数·**图像 OCR 与视觉问答**（图要够清晰，字至少 40 px）·
日志→表格（`json_equals`）·任意业务不变量（`python_check`）。

**委派 6/6 通过的那组**（2026-10-13，`delegate_batch`，14.1 s 本地算力）：多步算术答 `130`、
JSON 抽取、四词分类、字符计数、`is_prime`（`python_exec` 6 断言）、固定槽位摘要。

---



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

> ⚠️ **这三个指纹已被上面「2026-10-13 二轮」的 §9 取代**（`A21E2B31F686E714` / `E4BBC95796C558FC` /
> `E97A31E53762B133`）。本节以下所有出现 `60B3D4DE55512D8A` 的地方都是**历史值**，别拿它判断"哪个模块在跑"——
> 那件事只能用 0.6 的行为探针。
| `scripts/sync-install.mjs` | `D225D51552202305`（收尾提示改成"重启 DSH 本身"） |
| `tools/asar-read.py`（仓库根，新） | `CD36F311512831D3` — 直读 `app.asar` 的 `--find/--grep/--cat` |
| `tools/session-dump.mjs`（仓库根，新） | `B4BB192DBA302D17` — 逐帧解开 `session.v4.jsonl.zstd` |
| `tools/check-profile-roster.py`（仓库根，新，0.10） | `31682D08E82EA31D`（8,807 B）— 从文件 + 运行构建合成 patch 栈，求出 roster 与有效默认预置 |
| `tools/session-headers.mjs`（仓库根，新，0.12） | `328EB422CCD8D8DE`（4,411 B）— 逐会话只解第一帧，列出 `agentPreset`/空白/来源；`--preset X --blank` 找"被删预置卡住的空白会话" |
| `tools/session-set-preset.mjs`（仓库根，新，0.12） | `6989D7FF206C8DBB`（4,771 B）— 默认 dry-run；只重写会话的**第 0 帧**改 `agentPreset`，其余帧逐字节不动，自带备份与逐帧复核 |
| `tools/session-route-policy.mjs`（仓库根，新，2026-10-13 二轮） | `709F3631610C1164`（6,925 B）— 只读；逐会话解到 `subagentModelSelectionPolicy` 那一帧就停，按主/子会话列出「允许本地 / 钉在已删除模型 / 从无本地路由 / 无策略」。见上面 §3 末节 |
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
