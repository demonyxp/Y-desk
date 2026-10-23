# v0.5.0 验证说明

## 自动检查

```powershell
npm run check
npm test
$env:YDESK_GO_SERVER = (Resolve-Path .local/ydesk-server.exe).Path
npx.cmd playwright test
```

`YDESK_GO_SERVER` 指向 Windows 版 Go 信令测试程序；未设置时使用 Node 实现。Go 可用 `go build -o ../.local/ydesk-server.exe .` 在 `server-go` 目录构建。真实桌面测试需要已登录的 Windows 桌面；输入组件在隔离测试模式下记录事件，不操作用户桌面。

覆盖实际采集、模拟双屏、原始大小坐标、交换窗口、全屏、输入释放、无人值守、配置加密、身份保留、双向文本与文件、ICE 重协商及断开清理。文件选择和接收对话框在测试中使用临时目录替身；文件字节仍通过真实 WebRTC 数据通道传输并逐字节比较。

## 可重复的受限网络测试

```powershell
$env:YDESK_SHAPED = '1'
$env:YDESK_BENCH = '1'
npx.cmd playwright test e2e/desktop.spec.cjs --grep '双屏模拟' --output=.local/shaped-v050
Remove-Item Env:YDESK_SHAPED
Remove-Item Env:YDESK_BENCH
```

测试代理重写 ICE 候选，使真实 UDP 媒体与数据包经过每方向 60 ms 延迟、6 Mbps 限速和约 1% 丢包；断言实际 RTT 超过 100 ms，防止绕过代理误报成功。为获得可重写的 IP 候选，仅隔离测试进程放开媒体权限查询，不打开摄像头或麦克风。生产程序权限配置不变。

运动场景为两路 1920×1080、30 帧的移动图块和计数器，两端选择流畅档（总视频预算 4 Mbps），连续记录 15 个一秒样本。2026-10-23 本机的一次运行，两路均保持 1920×1080，样本约 27–31 fps，接收缓冲约 58–108 ms；随后切屏、双窗口控制及断开检查通过。结果依赖本机硬件、编解码器及测试图案，不能代替用户的实际跨境链路或复杂视频内容测试。

比较旧版时，设置 `YDESK_TEST_APP` 为旧版源码应用目录，并设置 `YDESK_BENCH_ONLY=1` 仅运行运动采样。混合版本测试可设置 `YDESK_OLD_HOST` 为 v0.4.0 应用目录，控制端保持当前版本。每次测试结束后清除这些环境变量。

## 打包与更新

结束所有端到端测试后运行 `npm run dist`，避免 Windows 输入组件被测试进程占用。然后运行 `node e2e/update-package.cjs`，验证真实下载安装包、拒绝损坏文件及连接中禁止安装。最终系统安装调用使用替身，不覆盖本机安装。

服务器兼容目标为原有 Go 协议 v2；本次无需修改 Nginx 或 coturn。未登录用户服务器，也未测量用户的韩国中继线路。
