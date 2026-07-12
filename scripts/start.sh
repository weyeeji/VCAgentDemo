#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-18443}"
# Linux 系统常预设 HOSTNAME=机器名，不能用它做默认值，否则只会绑定内网地址。
BIND_HOST="${BIND_HOST:-0.0.0.0}"
STANDALONE_DIR="$ROOT_DIR/.next/standalone"
PID_FILE="$ROOT_DIR/data/server.pid"
LOG_FILE="$ROOT_DIR/data/server.log"

if [[ ! -f "$STANDALONE_DIR/server.js" ]]; then
  echo ">>> 未找到生产构建，正在执行 npm run build ..."
  npm run build
fi

echo ">>> 同步静态资源到 standalone ..."
mkdir -p "$STANDALONE_DIR/.next"
rm -rf "$STANDALONE_DIR/.next/static"
cp -r "$ROOT_DIR/.next/static" "$STANDALONE_DIR/.next/static"
rm -rf "$STANDALONE_DIR/public"
cp -r "$ROOT_DIR/public" "$STANDALONE_DIR/public"

if [[ -f "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env" "$STANDALONE_DIR/.env"
fi

mkdir -p "$ROOT_DIR/data"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo ">>> 停止旧进程 PID=${OLD_PID}"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
elif command -v lsof >/dev/null 2>&1; then
  OLD_PORT_PIDS="$(lsof -ti :"${PORT}" 2>/dev/null || true)"
  if [[ -n "$OLD_PORT_PIDS" ]]; then
    # shellcheck disable=SC2086
    kill $OLD_PORT_PIDS 2>/dev/null || true
  fi
fi

export PORT HOSTNAME="$BIND_HOST" NODE_ENV=production
export DATA_DIR="$ROOT_DIR/data"

echo ">>> 后台启动服务: http://${BIND_HOST}:${PORT}"
echo ">>> 日志: ${LOG_FILE}"
echo ">>> PID:  ${PID_FILE}"
cd "$STANDALONE_DIR"
nohup node server.js >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
disown || true

echo ">>> 已启动 (PID=$(cat "$PID_FILE"))，关闭终端不影响运行"
echo ">>> 停止: kill \$(cat \"$PID_FILE\")"
