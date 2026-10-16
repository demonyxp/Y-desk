# 实现说明

## 数据路径

```text
Windows 被控端                       Windows 控制端
Electron 桌面采集 ── WebRTC 视频 ──→ 两路 video / 单屏或并排
Windows SendInput ←─ RTCDataChannel ─ 鼠标、键盘、主动文本
       │                                    │
       └──────── WSS 信令服务器 ──────────────┘
                  配对、确认、SDP、ICE
```

信令只处理配对和协商，不承载录屏或视频帧。WebRTC 尝试直连；双方网络不允许直连时，通过用户自己的 TURN 中继加密媒体。信令断开即结束控制，避免脱离被控端可见状态继续操作。

## 模块

| 文件 | 职责 |
| --- | --- |
| `server/index.cjs` | 临时设备注册、128 位密钥、30 秒确认超时、单连接绑定、会话隔离、心跳与基础限流 |
| `src/main.cjs` | 信任边界、WSS 校验、本地允许状态、授权屏幕集合、输入组件生命周期、紧急退出 |
| `src/preload.cjs` | 固定 IPC 接口，渲染层没有任意文件或进程访问 |
| `src/renderer/renderer.js` | 双视频轨道、SDP/ICE 顺序、画质、控制事件和真实统计 |
| `src/shared.cjs` | 可测试的地址、ICE、按键及坐标校验 |
| `native/Input.cs` | SendInput、虚拟桌面坐标、Unicode 输入、按键状态及 3 秒看门狗 |

## 双屏与坐标

屏幕采集 `display_id` 对应 Electron `Display.id`。连接时固定用户勾选的最多两块屏幕，每块屏幕对应一个 video track，用 SDP `mid` 建立屏幕与轨道的对应关系，不依赖网络到达顺序。

观看端根据实际视频比例扣除黑边，再发送 0–1 归一化坐标和屏幕 ID。主进程验证屏幕已授权，将坐标换算为该屏幕 DIP，再调用 `screen.dipToScreenPoint` 转为 Windows 物理像素。原生组件以整个虚拟桌面范围转换为 SendInput 绝对坐标，包含负坐标屏幕。显示器插拔、分辨率或缩放改变后主动停止共享，重新确认布局。

## 安全与生命周期

- 首先验证访问密钥，然后由被控端明确允许。客户端主进程和信令服务均维护会话状态，不只依赖按钮隐藏。
- 信令会话 ID 为随机值；候选只能在已允许的配对内部转发。控制端不能发送主机 offer、替主机允许请求或跨会话发消息。
- 原生输入组件只在本地允许时启动；每次输入再验证会话、事件类型、范围、按键白名单和授权屏幕。没有执行任意命令的远程接口。
- 数据通道有序可靠，鼠标移动最多约 60 次/秒；发送缓冲积压时丢弃移动事件，严重积压直接断开。抬键、断开释放和原生看门狗防止“按住不放”。
- 无 Node 集成、启用 sandbox/contextIsolation、限制 CSP 和 IPC 来源；禁止导航和打开远程页面。
- 紧急退出由主进程全局快捷键处理，直接销毁窗口；渲染进程失去响应也关闭窗口，终止采集。
- 不持久化设备密钥、TURN 凭据，不记录信令内容，不自动读取剪贴板。截图预览和测试 trace 不应公开上传。
- 服务器属于受信任组件，没有附加的端到端身份指纹核验。需信任自托管服务器管理员和正确的 TLS 证书。

## 性能及验证边界

采用 Chromium 原生采集及 WebRTC，避免 JS 逐帧编码和图片传输。每路 sender 设置 `maxBitrate`、`maxFramerate`、`scaleResolutionDownBy`；流畅档优先帧率，高清档优先分辨率。编码器与硬件加速能力由浏览器、显卡、驱动和双方协商共同决定。

UI 的 RTT 是候选路径网络往返时间，不等于完整“输入到画面”延迟；fps 来源于 `framesDecoded` 差值，码率来源于 `bytesReceived` 差值。没有使用固定数字伪装实时统计。

两路模拟屏幕端到端测试覆盖双轨和切屏；单屏真实采集覆盖 Windows 采集链路。尚需使用两台真实电脑、两个物理显示器、不同 DPI 和公网 TURN 做最终环境验收。自动化原生输入使用 dry-run，不声称已经证明真实目标应用响应或 UAC 可控。

当前打包工具的开发依赖树包含 npm 报告的 `sprintf-js` 中等级拒绝服务告警；生产依赖只有 `ws`，审计无告警。未通过强制降级打包器或隐藏告警规避问题。发布环境应持续跟踪上游修复。

参考：[Electron 屏幕采集](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[显示器 API](https://www.electronjs.org/docs/latest/api/screen)、[WebRTC 编码参数](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)、[Windows SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。
