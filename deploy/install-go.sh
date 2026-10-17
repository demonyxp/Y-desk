#!/usr/bin/env bash
set -euo pipefail

# 在解压后的 Linux 服务端包内执行，不需要 Go、Node.js 或 Docker。
if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 root 或 sudo 执行安装。" >&2
  exit 1
fi
ydesk_source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for ydesk_command in systemctl ss curl install; do
  command -v "$ydesk_command" >/dev/null || { echo "缺少命令：$ydesk_command" >&2; exit 1; }
done
"$ydesk_source_dir/ydesk-server" -version

# 升级本服务可以占用原端口；其他程序占用时不停止它，交由用户先完成迁移。
if ! systemctl is-active --quiet ydesk-signaling.service; then
  if [[ -n "$(ss -H -ltn 'sport = :21120')" ]]; then
    echo "21120 已被占用，请先停止旧的 Y-Desk 信令服务，再执行安装。" >&2
    exit 1
  fi
fi
if ! id ydesk >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/y-desk --shell /usr/sbin/nologin ydesk
fi
install -d -m 0755 /opt/y-desk-server
# 同目录替换二进制，避免覆盖正在运行的文件；设备注册表保留在独立目录。
install -m 0755 "$ydesk_source_dir/ydesk-server" /opt/y-desk-server/ydesk-server.new
mv -f /opt/y-desk-server/ydesk-server.new /opt/y-desk-server/ydesk-server
install -m 0644 "$ydesk_source_dir/ydesk-signaling.service" /etc/systemd/system/ydesk-signaling.service
systemctl daemon-reload
systemctl enable ydesk-signaling.service
systemctl restart ydesk-signaling.service
for ydesk_attempt in {1..10}; do
  if systemctl is-active --quiet ydesk-signaling.service && curl --fail --silent --max-time 2 http://127.0.0.1:21120/health; then
    printf '\n信令服务已启动，并已设置开机启动。\n'
    exit 0
  fi
  sleep 1
done
journalctl -u ydesk-signaling.service -n 30 --no-pager
exit 1
