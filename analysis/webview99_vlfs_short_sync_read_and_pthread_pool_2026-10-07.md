# WebView99 移植：同步短读与 pthread 池两处缺陷（2026-10-07）

本文记录在 **无 JSPI（KRKR2_WEB_NO_JSPI=ON，面向 Android System WebView 99 / Chromium 99）**
构建上定位并修复的两个缺陷。两者都在 Web 平台适配层（`platforms/web/vlfs.js`、
`CMakeLists.txt` 链接选项），不涉及 `cpp/` 参考实现语义，因此不适用四参考二进制
函数取证前置条件；但它们都会改变 Web 层运行行为，故在此留档。

对照基线：上游 JSPI 构建（`out/web/release-jspi`，`KRKR2_WEB_PTHREAD_POOL_SIZE=0` +
`platforms/web/pthread_jspi.js`），同一游戏（千恋＊万花）、同一注册参数
（9 个 XP3 + 67 个散装文件，`?xp3=` / `?remote=`）。

## 现象

进入游戏（点"新的故事"）后：

| 观察项 | 无 JSPI 构建（修复前） | 上游 JSPI 构建 |
|---|---|---|
| 画面 | 全黑，只有 UI | 正常（章节标题、立绘、背景） |
| `affinesourceimage.tjs:loadImages` 异常 | 11–12 | 11 |
| 归档读取次数（data/patch/voice/bgm/bgimage1080/fgimage1080/evimage1080） | 19/15/7/6/5/3/3 | 19/15/7/6/5/3/3（完全一致） |
| worker 崩溃 | `RuntimeError: table index is out of bounds`、`null function or function signature mismatch`、`pthread mutex deadlock` | 无 |

归档读取次数与上游**逐项一致**，说明代码路径相同、素材确实被读取；差异只在
Web 层线程与 I/O 处理。

## 缺陷 A：主线程同步读把"合法短读"当错误抛出

### 证据

加 `-sASSERTIONS=2 --profiling-funcs`（**仅链接期开关**，编译产物复用 ccache，
不需重编译 C++）后得到可读堆栈：

```
[vlfs] sync read failed: Error: vlfs: short sync range 4783 < 9568
    at Object._syncRange (vlfs.js)
    at Object._readSourceSync (vlfs.js)          # case 'remote' / 'zip'
    at Object.readSync (vlfs.js)
    at vlfs_js_read_sync
    at VLFS::Read(int, void*, int)               # wasm-function[9551]
    at tTVPLocalFileStream::Read(void*, unsigned int)
    at TJS::tTJSBinaryStream::ReadBuffer(void*, unsigned int)
```

引擎请求 9568 字节，服务端按 HTTP 语义只返回文件剩余部分（4783 字节，206 + 较短
body）。`_syncRange` 里的 `if (text.length < len) throw ...` 把这种**合法短读**判为
I/O 失败。读失败后引擎的流对象进入不一致状态，随后 worker 线程侧的异常与
`pthread_mutex_timedlock` 死锁断言级联出现（即"对话几句就加载不出来"）。

### 修复（`platforms/web/vlfs.js`）

1. `_syncRange`：短读不再抛错，返回实际收到的字节（`Math.min(text.length, len)`）。
2. `readSync` 大读分支：`f.pos += big.length`（按**实际**长度推进，而不是请求长度）。
3. `readSync` 块缓存分支：返回值取 `_assembleFromBlocks` 的实际组装数，
   并据此推进 `f.pos`。
4. `_assembleFromBlocks`：块缺失或短块时 `break` 并返回已组装字节数。
   修复前短块会让 `n = 0`、`done` 不前进 → **死循环**（同一个短读问题的第二种表现）。
5. 异步 `read()` / 已缓存读路径同样按实际长度推进（数据源提前结束时语义一致）。

### 验证

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `sync read failed` | 3 | **0** |
| `table index is out of bounds` | 4 | **0** |
| `worker sent an error` | 2 | **0** |
| 画面 | 黑屏 | 进入 CHAPTER 1-1、对话框与 KAG UI 正常 |

## 缺陷 B：pthread 预建池不足以覆盖引擎峰值

### 证据

无 JSPI 构建用预建池替代上游的"等 Worker 就绪"包装（`pthread_jspi.js` + 
`--wrap=pthread_create*`，见 `platforms/web/pthread_jspi.js` 文件头："acquire a fully
loaded Worker before pthread_create returns"）。修复缺陷 A 之后：

| `KRKR2_WEB_PTHREAD_POOL_SIZE` | 线程池耗尽告警 | worker 崩溃 | 结果 |
|---|---|---|---|
| 0（按需创建，与上游同） | 42 | `table index` ×4 | 黑屏 |
| 8 / 32 | 20–42 | 0 | 进入游戏，但创建失败的线程所负责的工作缺失 |
| **64** | **0** | **0** | 进入游戏，全部计数归零 |

结论：引擎进入游戏后创建的 pthread 数超过 32；池满时默认
`PTHREAD_POOL_SIZE_STRICT` 语义让 `pthread_create` 直接失败，而改用 `STRICT=0`
退回"按需新建 Worker"在无 JSPI 下不可用——新建 Worker 尚未就绪即被调用，表现为
`table index is out of bounds` / `null function or function signature mismatch`。
**平台边界**：无 JSPI 时无法在 `pthread_create` 返回前等待 Worker 冷启动
（上游用 JSPI 的 `Asyncify.handleAsync` 实现该等待），因此本构建只能靠足够大的
预建池规避，而非复刻上游机制。

### 修复（`CMakeLists.txt`）

- `KRKR2_WEB_NO_JSPI` 分支默认 `KRKR2_WEB_PTHREAD_POOL_SIZE=64`。
- 追加 `-sPTHREAD_POOL_SIZE_STRICT=0`：池意外耗尽时不静默失败（按需路径仍不可用，
  但至少不会让引擎误以为线程已创建）。

## 缺陷 C：`WaveSoundBuffer.totalTime` / `position` 在"尚未打开"窗口内除零（wasm 陷阱）

### 证据

长时间推进对话（20 次点击 + 9 次按键，每 9 秒一步）后，19 张定时截图从第 5 张起
**哈希完全相同**（画面冻结），而所有错误计数为 0——不是崩溃而是静默停住。
用带函数名的诊断构建（`-sASSERTIONS=2 --profiling-funcs`）拿到唯一一条异常：

```
[exception] RuntimeError: divide by zero
    at tTJSNC_WaveSoundBuffer::tTJSNC_WaveSoundBuffer()::NCM_totalTime::Get(TJS::tTJSVariant*, TJS::iTJSDispatch2*)
    at TJS::tTJSNativeClassProperty::PropGet(unsigned int, char16_t const*, unsigned int*, TJS::tTJSVariant*, TJS::iTJSDispatch2*)
    at TJS::TJSDefaultPropGet(...)
    at TJS::tTJSCustomObject::PropGet(...)
    at TJS::tTJSInterCodeContext::GetPropertyDirect(...)
```

即脚本读取 `WaveSoundBuffer.totalTime` 触发除零。该陷阱打断引擎主循环，之后画面
永久冻结——正对应"对话过几句就加载不出来"。

代码位置（`cpp/core/sound/win32/WaveImpl.cpp`，修改前）：

```cpp
tjs_uint64 tTJSNI_WaveSoundBuffer::GetTotalTime() {
    return InputFormat.TotalSamples * 1000 / InputFormat.SamplesPerSec;
}
```

### 与已记录平台边界的关系

`Open()` 的 `KRKR2_WEB_NO_JSPI` 分支（同文件）已记录边界：**无 JSPI 时无法让主线程
同步等待异步解码器创建，只能退化为异步——TJS 侧在提交前会观察到"尚未打开"**。
本缺陷是该边界在 TJS 可观察面上的直接后果：提交前 `InputFormat.SamplesPerSec == 0`。

### 为什么"显式返回 0"是与参考实现一致的复刻

四个参考二进制全部是 **ARM**（Android arm64-v8a / armeabi-v7a、iOS arm64 / armv7）。
ARM 的整数除零（`UDIV`/`SDIV` by zero）按架构定义**返回 0**，不产生异常；而 wasm 的
`i32.div_s` 会**陷阱**。因此参考平台上脚本在此读到的结果就是 **0**；显式 `return 0`
复刻的是参考平台的可观察结果，而不是引入新的语义。

### 修复

`GetTotalTime()` 与 `GetPosition()` 在 `InputFormat.SamplesPerSec == 0` 时返回 0
（两处是全文件仅有的按 `SamplesPerSec` 做除法的位置）。`WaveIntf.cpp` 中的
`format.TotalTime = format.TotalSamples * 1000 / format.SamplesPerSec` 位于 RIFF
头解析路径，`SamplesPerSec` 来自文件头而非"尚未打开"状态，不属于本边界，未改动。

### 验证

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 19 张定时截图（每 9 秒一张） | 第 5 张起全部相同（冻结） | **19 张全部不同**（持续推进） |
| `divide by zero` | 1 | **0** |
| 全部 `[exception]` | 11–12 | **0** |
| 画面 | 停在天空背景 | 对话推进到后续台词（【司机】「非常感谢」） |

## 仍未解决

（原"背景与立绘未绘制"的症状在缺陷 A、B、C 修复后已消失：背景正常渲染、对话可持续
推进。人物立绘是否在需要出现的场景正常绘制仍需继续观察。）
