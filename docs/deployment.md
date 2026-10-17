# 公网部署

**无需 Docker / Node.js：使用 [Go 独立服务端](go-server.md)**，下载 Linux 程序即可运行，兼容现有 Windows 客户端。

**服务器已安装宝塔 / Nginx：请使用 [Ubuntu + 宝塔部署](baota.md)**，避免独立 Caddy 占用现有网站的 80/443 端口。

需要一台 Linux 服务器、Docker Compose、可解析到服务器公网 IPv4 的域名。默认示例使用 Caddy 自动申请证书、Node 信令和 coturn。此仓库不含已经上线的公共服务。

v0.2.0 使用新的密码认证协议，**客户端和服务器需要一起升级**。设备码的所有权摘要保存在 `signaling_data` Docker 卷（容器内 `/data/devices.json`）。保留并备份此卷，不要使用 `docker compose down -v` 删除注册信息。丢失注册表后，服务器无法判断既有设备码的原所有者。

## Docker Compose

```bash
git clone https://github.com/demonyxp/Y-desk.git
cd Y-desk/deploy
cp .env.example .env
openssl rand -hex 24
```

编辑 `.env`，填写真实域名、服务器公网 IP、TURN 用户名和刚生成的随机密码，不要提交 `.env`：

```dotenv
DESK_DOMAIN=desk.example.com
PUBLIC_IP=203.0.113.10
TURN_USERNAME=ydesk
TURN_PASSWORD=替换为生成的随机密码
```

域名/IP 为示例，必须替换。DNS 应直连服务器；TURN 域名不可套只支持 HTTP 的 CDN 代理。

开放云安全组及服务器防火墙端口：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 80 | TCP | Caddy 证书验证 / HTTPS 跳转 |
| 443 | TCP | 加密信令 WSS |
| 3478 | UDP + TCP | STUN / TURN 客户端连接 |
| 49160–49259 | UDP | TURN 媒体中继端口范围 |

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 signaling caddy turn
curl --fail https://desk.example.com/health
```

健康检查应返回 `{"ok":true}`。它只证明信令 HTTP 服务可访问，**不能证明 TURN 可用或两端视频已经连通**。客户端连接后的“直连/中继”和实际视频统计才是媒体链路证据。

默认 TURN 使用主机网络，只适用于 Linux Docker。服务器若位于 NAT 后，公网 UDP 端口需一对一映射到服务器相同端口，并根据实际网卡配置 coturn `external-ip=公网IP/内网IP`。TURN 禁止向内网目标转发，减少被用作内网代理的风险。

## 客户端填写

两台电脑都填写：

```text
wss://desk.example.com
```

STUN / TURN 配置（替换域名及凭据）：

```json
[
  { "urls": "stun:desk.example.com:3478" },
  {
    "urls": [
      "turn:desk.example.com:3478?transport=udp",
      "turn:desk.example.com:3478?transport=tcp"
    ],
    "username": "ydesk",
    "credential": "与你的TURN_PASSWORD相同"
  }
]
```

ICE 优先选择可用直连路径，必要时经 TURN 中继。TURN TCP 是 UDP 不通时的备选，但丢包下可能增加延迟。此模板未提供 TURN TLS/443；只允许 443 出站的企业网络需要额外配置独立 TURN TLS 服务，不能把 TURN 协议当普通 HTTP 反向代理。

静态 TURN 账号适合私人小规模部署。若对外提供服务，应增加账号系统、短期 TURN 凭据、接入限流、带宽配额及监控。不要向不可信人公开 TURN 密码，也不要长期使用示例密码。

## 不使用 Docker

信令仅需要 Node.js 24：

```bash
npm ci --omit=dev --ignore-scripts
HOST=127.0.0.1 PORT=21120 node server/index.cjs
```

由已有 Caddy / Nginx 提供 HTTPS 和 WebSocket Upgrade 反向代理，目标 `http://127.0.0.1:21120`。不要直接把明文信令端口开放公网。TURN 单独按上面的配置部署。

非 Docker 默认将设备注册表写入 `data/devices.json`，可通过 `STATE_PATH` 指定位置。服务用户必须有写权限。密码明文和密码派生凭据不写入服务器注册表；在线会话只在内存保留派生凭据的摘要。

已有可信 SSH 服务器时，也可用隧道做双机测试：服务器上运行回环信令，两台 Windows 分别保持以下 PowerShell 命令运行，然后客户端使用 `ws://127.0.0.1:21120`：

```powershell
ssh -N -L 21120:127.0.0.1:21120 用户名@服务器地址
```

SSH 隧道仅承载信令。媒体仍通过 WebRTC 直连/中继，跨 NAT 时仍可能需要 TURN。

## 更新与排错

```bash
git pull --ff-only
cd deploy
docker compose up -d --build
docker compose ps
curl --fail https://desk.example.com/health
```

若已位于 `deploy` 目录，省略再次 `cd deploy`。重启信令会结束现有连接；无人值守主机会自动重新上线，控制端重新点击连接；普通共享需再次开启。

- 连不上信令：检查域名、443、证书、服务器日志。客户端不会跳过证书校验。
- 设备码或密码错误：确认两端使用同一服务器、对方已开启共享、密码大小写正确。连续 5 次错误后，当前设备的密码尝试会暂时受限。
- 已允许但无画面：检查 ICE、3478、UDP 中继端口和公网 IP；空 ICE 在跨 NAT 环境通常不够。
- 画面卡顿：先选“流畅”；检查被控端上传带宽、实际 RTT 和中继距离。两块 4K 屏幕成本明显高于一块 1080p。
- 能看不能控制：点击视频取得焦点，确认没有“仅观看”；UAC 和高权限窗口不受普通权限程序控制。

参考：[Caddy WebSocket 代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[coturn Docker 文档](https://github.com/coturn/coturn/tree/master/docker/coturn)。
