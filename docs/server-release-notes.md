# Y-Desk Go 服务端 v0.1.0

- 提供 Linux amd64 / arm64 独立信令程序，运行时不需要 Go、Node.js、npm 或 Docker。
- 兼容现有客户端协议 v2：固定设备码、自设密码、普通确认、无人值守以及双屏 WebRTC 协商。
- 沿用 Node 服务端设备注册表格式，支持原有设备身份迁移。
- 保留密码错误限流、请求超时、会话方向校验、连接数限制及慢连接清理。
- 包含 systemd 开机启动脚本、宝塔 Nginx 反向代理片段和 coturn 配置模板。

解压对应架构的包后，以 root 执行 `bash install.sh`。信令监听 `127.0.0.1:21120`，宝塔反代到该端口；数据持久化在 `/var/lib/y-desk/devices.json`。完整步骤见压缩包内 README 或仓库 `docs/go-server.md`。

本发布只用于服务器，不替换 Windows 客户端，也不占用客户端自动更新的 latest 发布。TURN 中继仍需单独安装 coturn；高清流畅度仍受实际网络、带宽和两端硬件影响。
