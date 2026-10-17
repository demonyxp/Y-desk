# Ubuntu + 宝塔 Nginx 部署

宝塔管理域名和 HTTPS；Docker 只运行信令与 TURN。使用 `compose.baota.yml` 后，Caddy 默认不启动，信令端口仅绑定 `127.0.0.1`。本方案要求宝塔 Nginx 在宿主机运行。若宝塔使用 Apache 或 Nginx 在容器里，需另行调整代理配置。

以下以 `desk.example.com` 为例，替换成自己的域名。服务器需安装 Git、Docker Engine 和 Docker Compose 插件，命令在服务器 SSH / 宝塔终端以 root 执行。安装 Docker 可通过宝塔的软件商店，或参考 [Docker Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)。

## 1. 域名和端口

域名 A 记录解析到服务器公网 IPv4，使用 DNS 直连，关闭 CDN 代理。没有配置 IPv6 的服务器不要添加 AAAA 记录。

云安全组与服务器防火墙都需放行：TCP 80、443；TCP/UDP 3478；UDP 49160–49259。不要开放公网 21120。TURN 端口直连服务器，无需配置 Nginx 代理。

## 2. 下载代码并配置

```bash
docker --version
docker compose version
mkdir -p /opt
git clone https://github.com/demonyxp/Y-desk.git /opt/y-desk
cd /opt/y-desk/deploy
cp .env.example .env
chmod 600 .env
openssl rand -hex 24
```

若此前已克隆，进入原仓库执行 `git pull --ff-only`，保留已有 `.env`，不要重复复制覆盖。

编辑 `.env`：

```dotenv
DESK_DOMAIN=desk.example.com
PUBLIC_IP=服务器公网IPv4
TURN_USERNAME=ydesk
TURN_PASSWORD=刚生成的随机密码
```

TURN 密码与桌面连接密码是两套独立凭据。若云服务器公网 IP 经 NAT 映射到内网网卡，`PUBLIC_IP` 可填写 `公网IPv4/内网IPv4`；端口必须映射到相同端口。内网地址通过 `ip -4 addr` 查看，公网地址以云控制台为准。

## 3. 启动 Docker 服务

```bash
cd /opt/y-desk/deploy
docker compose -f compose.yml -f compose.baota.yml config --quiet
docker compose -f compose.yml -f compose.baota.yml up -d --build signaling turn
docker compose -f compose.yml -f compose.baota.yml ps
curl --fail http://127.0.0.1:21120/health
```

应返回 `{"ok":true}`。本命令不启动 Caddy，不占用宝塔的 80/443。

如果此前用独立 Caddy 方案启动过本项目，先在同一项目目录执行 `docker compose stop caddy`，再切换到此方案。不要停止宝塔 Nginx。

## 4. 宝塔站点与 SSL

在宝塔“网站”中新建站点，绑定域名，使用纯静态站点即可，无需数据库或 PHP。进入站点 SSL 设置，申请并部署该域名的 Let's Encrypt 证书，成功后开启强制 HTTPS。

进入该站点“反向代理”，新增：代理目录 `/`，目标 URL `http://127.0.0.1:21120`，发送域名 `$host`，关闭缓存，开启 WebSocket（面板版本有此选项时）。随后编辑这条代理的配置，用 [nginx-ydesk.conf](../deploy/nginx-ydesk.conf) 的内容替换其 `location /`。不要把片段替换整个站点配置或 SSL 配置，也不要添加重复的 `location /`。

保存后验证并重载：

```bash
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
curl --fail https://desk.example.com/health
```

应返回 `{"ok":true}`。此检查只验证信令入口，TURN 仍需通过真实远程连接确认。

## 5. 客户端

两台电脑的信令服务器填写 `wss://desk.example.com`，STUN / TURN 填写：

```json
[
  { "urls": "stun:desk.example.com:3478" },
  {
    "urls": ["turn:desk.example.com:3478?transport=udp", "turn:desk.example.com:3478?transport=tcp"],
    "username": "ydesk",
    "credential": "与服务器TURN_PASSWORD一致"
  }
]
```

被控端开启共享，控制端使用设备码和桌面连接密码连接。此处 `credential` 才使用 TURN 密码。

## 日志、升级和数据

```bash
cd /opt/y-desk/deploy
docker compose -f compose.yml -f compose.baota.yml logs --tail=80 signaling turn
git pull --ff-only
docker compose -f compose.yml -f compose.baota.yml up -d --build signaling turn
docker compose -f compose.yml -f compose.baota.yml ps
curl --fail https://desk.example.com/health
```

升级信令会断开现有远程连接，无人值守主机会自动重新上线。保留同一项目目录和 `signaling_data` 数据卷，不要执行 `down -v`。备份设备注册表及 `.env`，不要将凭据提交到 Git。

参考：[宝塔反向代理](https://docs.bt.cn/user-guide/site/php/site-config/reverse-proxy)、[Nginx WebSocket 代理](https://nginx.org/en/docs/http/websocket.html)。
