# Go 服务端：Ubuntu + 宝塔，无需 Docker / Node.js

Go 版只替换信令服务，兼容现有 v0.2.x / v0.3.x Windows 客户端。屏幕采集、编码和控制仍在两端电脑运行；跨网络无法直连时仍需 coturn 中继。下载的程序已编译，服务器不需要安装 Go。

## 1. 安装信令服务

在 Ubuntu 的 root 终端执行。若已安装旧的 Node / Docker 信令服务，先停止旧服务并迁移设备注册表，避免抢占 21120 端口；不要停止宝塔 Nginx。

```bash
apt-get update
apt-get install -y curl ca-certificates iproute2 unzip
uname -m
```

`x86_64` 使用 amd64 包；`aarch64` / `arm64` 使用 arm64 包。以下命令自动选择并下载安装包：

```bash
(
set -euo pipefail
case "$(uname -m)" in
  x86_64) ydesk_arch=amd64 ;;
  aarch64|arm64) ydesk_arch=arm64 ;;
  *) echo "暂不支持该服务器架构"; exit 1 ;;
esac
mkdir -p /opt/ydesk-install
cd /opt/ydesk-install
ydesk_release=https://github.com/demonyxp/Y-desk/releases/download/server-v0.1.0
ydesk_package="ydesk-server-linux-${ydesk_arch}"
curl -fLO "$ydesk_release/$ydesk_package.zip"
unzip -o "$ydesk_package.zip"
chmod +x "$ydesk_package/ydesk-server"
bash "$ydesk_package/install.sh"
)
```

安装脚本创建 `ydesk` 系统用户，用 systemd 启动服务，并设置开机启动。程序安装在 `/opt/y-desk-server/ydesk-server`，数据位于 `/var/lib/y-desk/devices.json`。端口只监听 `127.0.0.1:21120`，公网通过宝塔 Nginx 访问。

```bash
systemctl status ydesk-signaling --no-pager
curl --fail http://127.0.0.1:21120/health
```

应返回 `{"ok":true}`。默认服务限制 128 个在线 WebSocket 连接、128 MB 内存，并设置 Go 的 96 MiB 软内存目标；这些是资源保护阈值，不代表实际占用或容量承诺。

## 2. 宝塔配置 desk.yinsane.xyz

将域名 A 记录解析到服务器公网 IPv4，关闭 CDN 代理。宝塔 Nginx 新建该域名的纯静态站点，申请并部署 SSL 证书，开启强制 HTTPS。

在站点反向代理中设置：目录 `/`，目标 `http://127.0.0.1:21120`，发送域名 `$host`，关闭缓存并开启 WebSocket。下载包内的 `nginx-ydesk.conf` 已包含完整的 `location /` 片段及超时设置，可替换这条代理配置；不要覆盖整个站点文件或重复添加 `location /`。

```bash
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
curl --fail https://desk.yinsane.xyz/health
```

两台电脑的信令地址填 `wss://desk.yinsane.xyz`。此时信令已部署，但健康检查不能证明跨网络视频或 TURN 已连通。

## 3. 安装 TURN 中继

首次安装 coturn 后，在配置账号和公网 IP 前先停止服务：

```bash
apt-get install -y coturn
systemctl disable --now coturn
```

如果服务器已经有其他业务使用 coturn，保留原服务配置，另外分配端口和账号，不要覆盖。新安装时先备份默认配置，再从解压目录安装模板（amd64 示例，ARM 对应修改目录名）：

```bash
cp -a /etc/turnserver.conf "/etc/turnserver.conf.bak.$(date +%Y%m%d%H%M%S)"
install -m 0640 -o root -g turnserver /opt/ydesk-install/ydesk-server-linux-amd64/turnserver.conf.example /etc/turnserver.conf
```

用宝塔文件管理或 `nano /etc/turnserver.conf` 编辑以下三项，其他限制保留：

```ini
realm=desk.yinsane.xyz
external-ip=你的服务器公网IPv4
user=ydesk:自己设置的较长字母数字密码
```

若公网 IP 通过 NAT 映射到内网网卡，填写 `external-ip=公网IPv4/内网IPv4`，并确保中继端口一对一映射。模板不读取 Docker 的 `.env`，须直接修改此配置文件。

云安全组和宝塔防火墙放行 TCP 80、443，TCP/UDP 3478，UDP 49160–49259。不要向公网开放 21120。填好配置后启动：

```bash
systemctl enable --now coturn
systemctl status coturn --no-pager
journalctl -u coturn -n 50 --no-pager
```

两台客户端都填写：

```json
[
  { "urls": "stun:desk.yinsane.xyz:3478" },
  {
    "urls": ["turn:desk.yinsane.xyz:3478?transport=udp", "turn:desk.yinsane.xyz:3478?transport=tcp"],
    "username": "ydesk",
    "credential": "与turnserver.conf中user配置的密码一致"
  }
]
```

TURN 密码用于中继认证；桌面连接密码仍由被控端在客户端内自行设置。

## 4. 日常管理、升级与迁移

```bash
systemctl restart ydesk-signaling
journalctl -u ydesk-signaling -n 80 --no-pager
/opt/y-desk-server/ydesk-server -version
```

升级时下载新的服务端包，解压后再次执行包中的 `install.sh`。脚本替换程序并重启服务，现有连接会断开，无人值守主机随后自动上线。数据目录不删除，必须定期备份。

从 Node 服务端迁移时，注册表 JSON 格式相同。先停止旧服务，在首次启动 Go 服务前复制原 `data/devices.json`（Docker 为 `signaling_data` 卷内文件）。保留已有的 Go 注册表，不要把两个运行中的服务指向同一份数据文件：

```bash
id ydesk >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/y-desk --shell /usr/sbin/nologin ydesk
install -d -m 0700 -o ydesk -g ydesk /var/lib/y-desk
# 将下方路径替换成旧注册表的真实路径，再执行。
install -m 0600 -o ydesk -g ydesk /旧服务目录/data/devices.json /var/lib/y-desk/devices.json
```

设备注册表只保存所有权摘要，不保存桌面密码。设备码和无人值守配置仍由客户端保存，原客户端无需重新安装。

## 开发验证

源码位于 `server-go/`，使用 Go 1.27.2 构建。`go test -race ./...` 检查并发和资源边界；`go vet ./...` 静态检查。设置 `YDESK_GO_SERVER` 为编译出的程序绝对路径后，运行原有的 `tests/signaling.test.cjs`、`tests/go-migration.test.cjs` 和桌面 E2E 测试，即可用同一套客户端验证 Go 后端。

参考：[Go WebSocket 库](https://pkg.go.dev/github.com/gorilla/websocket)、[宝塔反向代理](https://docs.bt.cn/user-guide/site/php/site-config/reverse-proxy)、[coturn 配置](https://github.com/coturn/coturn/wiki/turnserver)。
