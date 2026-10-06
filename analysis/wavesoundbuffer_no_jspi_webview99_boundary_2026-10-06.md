# WaveSoundBuffer 无 JSPI（Android WebView 99 / Chromium < 137）平台边界（2026-10-06）

> 前置阅读：
> - `analysis/wavesoundbuffer_jspi_sync_semantics_four_binary_2026-08-30.md`（当前 JSPI 方案：
>   挂起原 TJS 调用栈，恢复后同步提交状态）
> - `analysis/wavesoundbuffer_web_async_status_four_binary_2026-08-30.md`（无挂起能力时的
>   兼容策略与其失败模式分析）
>
> 本文不重新做四文件反编译，只记录**构建模式差异**：四个参考二进制共同证明的
> `Open -> ssStop`、`Play -> ssPlay -> TJS return` 同步契约（地址与逐端差异见上述两篇）
> 在无 JSPI 构建中**无法用同一手段**满足，以及本构建采用的替代策略与验证缺口。

## 平台边界的具体技术原因

四个参考二进制的 `Play()` 在 `StartPlay()`（首次 L2 解码 + 四次 FillBuffer + 设备 Play）
**全部完成之后**、返回 TJS 之前执行 `SetStatus(ssPlay)`。

JSPI 构建复刻这一边界的方式是 `WebAssembly.Suspending/promising`：`Play()` 在启动
continuation 后挂起，等 completion 唤醒**同一个 TJS 调用栈**，再同步 `SetStatus(ssPlay)`
返回脚本。

Android System WebView 99（Chromium 99）**没有 `WebAssembly.Suspending/promising`**
（Chromium 137 才提供），也无法使用 Asyncify（会与 `-pthread` 和主循环语义冲突）。
因此在无 JSPI 构建中：

- `Open()` 不能阻塞等待异步解码器创建 —— 只能立即返回并保持 pending；
- `Play()` 不能阻塞等待设备启动完成 —— 同理。

这是**不可避免的平台边界**：不是"改动 oracle 观察不到"，而是语言运行时缺少栈切换能力，
同步阻塞在单线程主线程上必然死锁（事件循环无法推进 async 供数）。

## 采用的替代策略（对应上一篇的修复要求 1–5）

无 JSPI 构建改用"**接受请求即发布逻辑状态**"策略，即
`wavesoundbuffer_web_async_status_four_binary_2026-08-30.md` 记录的兼容方案，并满足其
列出的全部 5 条要求：

| 要求 | 本构建实现位置（`cpp/core/sound/win32/WaveImpl.cpp`） |
|---|---|
| 1. 异步打开期间收到 Play 立即发布 `ssPlay` | `Play()` 的 `AsyncOpenPending` 分支：`AsyncPlayPending = true; SetStatus(ssPlay); return;` |
| 2. 启动异步播放后也立即发布 `ssPlay` | `Play()` 的 `StartPlayAsync()` 之后：`SetStatus(ssPlay); return;` |
| 3. `FinishOpenAsync` 有排队播放时保持 `play`（不伪造 `play -> stop`） | `FinishOpenAsync()`：`if(play) Play(); else SetStatus(ssStop);`（`Decoder`/`InputFormat` 已在 `CompleteOpenAsync` 中就位，故 `Play()` 会真正启动） |
| 4. 首次填充失败发布 `ssStop`，释放等待中的 conductor | `CompleteStartPlayAsync()`：`SetStatus(context->Started ? ssPlay : ssStop)` |
| 5. 启动完成时幂等收敛到 `ssPlay`，不产生额外事件 | 同上（`SetStatus` 幂等，仅在值变化时发事件） |

`AsyncPlayPending` 字段**只在 `KRKR2_WEB_NO_JSPI` 下存在**：JSPI 构建中 `Open()` 在
continuation 期间不返回，脚本不可能在 `AsyncOpenPending` 为真时进入 `Play()`，因此该字段
在 JSPI 构建中按设计不存在（JSPI 文档第 96 行的"旧的 AsyncPlayPending 路径已移除"仍然成立）。

## 与 JSPI 构建的语义差异（必须记录）

| 行为 | 四参考 / JSPI 构建 | 无 JSPI 构建（本构建） |
|---|---|---|
| `Play()` 返回时 `status` | `play` | `play`（一致） |
| `Play()` 返回时设备是否已启动 | 是 | **否**（启动在后续 completion 中完成） |
| `Open()` 返回时 `Decoder`/`InputFormat` 是否就绪 | 是 | **否**（`AsyncOpenPending` 为真） |
| 打开失败的异常传播 | 在原 `Play()`/`Open()` 调用栈重新抛出 | **只能记日志**（`TVPAddImportantLog`），无法回抛给已经返回的 TJS 调用者 |
| 可挂起的等待函数 | `__asyncjs__TVPWaitWaveSoundContinuation` | **不定义**（`EM_ASYNC_JS` 依赖 JSPI/Asyncify）；只保留 `TVPCompleteWaveSoundContinuation` completion 桥 |

因此本构建下"脚本可观察的逻辑状态顺序"与四参考一致，但"返回时底层是否已完成初始化"
这一**非脚本可观察**的边界不同；打开失败从同步异常退化为日志。

## 验证状态与缺口

- 无 JSPI 构建在 Chromium 99.0.4844.0 上：引擎启动零 error/warning，远程 XP3 同步读解析
  （41 files/41 segments）并渲染 KAG3 intro 场景；90 秒稳定性采样堆恒定 14 MB
  （见 `webview99-port-plan.md` §5.3）。
- **缺口**：状态契约的运行时验证需要带 `sysvoice ... wait` 一类脚本的游戏
  （`wavesoundbuffer_web_async_status_four_binary_2026-08-30.md` 使用的是
  `KRkr高压_千恋万花.zip`）。本环境没有该物料，`kag3_intro.xp3` / `kag3_template.xp3`
  的 intro 流程不调用 `PlayBGM`/`sysvoice`，故**不加相关测试、也不合成音频物料**；
  按项目规范保留该验证缺口。
