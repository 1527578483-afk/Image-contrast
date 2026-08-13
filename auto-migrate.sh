#!/bin/bash
# Auto-migrate: export from Edge → import to Electron, fully automated
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/node-v20.19.4-darwin-arm64/bin:$PATH"

MIGRATE_URL="file://${SCRIPT_DIR}/migrate.html"
SERVER_URL="http://localhost:9877"
EDGE_APP="/Applications/Microsoft Edge.app"
ELECTRON_BIN="${SCRIPT_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
ok()  { echo -e "${GREEN}[$(date +%H:%M:%S)] ✅${NC} $1"; }
err() { echo -e "${RED}[$(date +%H:%M:%S)] ❌${NC} $1"; }

cleanup() {
  log "清理中..."
  # Kill migration server
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  # Kill Electron if we started it
  if [ -n "$ELECTRON_PID" ]; then
    kill "$ELECTRON_PID" 2>/dev/null || true
  fi
  log "已停止所有服务"
}

trap cleanup EXIT

# ─── Step 0: Prerequisites check ────────────────────────
log "=========================================="
log "  视频档案 — 自动数据迁移"
log "=========================================="

if [ ! -f "$EDGE_APP/Contents/MacOS/Microsoft Edge" ]; then
  err "找不到 Microsoft Edge，请确认已安装"
  exit 1
fi

if [ ! -f "$ELECTRON_BIN" ]; then
  err "找不到 Electron，请先运行 npm install"
  exit 1
fi

# Kill any existing server on our port
EXISTING=$(lsof -ti :9877 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  log "关闭已有服务器进程..."
  kill $EXISTING 2>/dev/null || true
  sleep 1
fi

# Clean previous migration data
if [ -d "${SCRIPT_DIR}/migration-data" ]; then
  log "清理旧的迁移数据..."
  rm -rf "${SCRIPT_DIR}/migration-data"
fi

# ─── Step 1: Start migration server ─────────────────────
log "启动迁移服务器..."
node "${SCRIPT_DIR}/migrate-server.js" &
SERVER_PID=$!
sleep 2

# Verify server is up
if ! kill -0 $SERVER_PID 2>/dev/null; then
  err "迁移服务器启动失败"
  exit 1
fi

if ! curl -s "${SERVER_URL}/list" > /dev/null 2>&1; then
  err "迁移服务器无响应"
  exit 1
fi
ok "迁移服务器已启动 (PID: $SERVER_PID)"

# ─── Step 2: Export from Edge ───────────────────────────
log ""
log "=========================================="
log "  阶段 1/2: 从 Edge 导出视频数据"
log "=========================================="
log "正在打开 Edge 浏览器..."
log "URL: ${MIGRATE_URL}#auto=export"

# Kill existing Edge if needed (user data stays intact)
# We just open the page — Edge reads IndexedDB and POSTs to server
open -a "Microsoft Edge" "${MIGRATE_URL}#auto=export" 2>/dev/null || {
  err "无法打开 Edge 浏览器"
  exit 1
}
ok "Edge 已启动 — 正在自动导出..."

# Wait for Edge to start and begin export
sleep 5

# Poll for export completion
log "等待导出完成（视频文件较多，请耐心等待）..."
EXPORT_TIMEOUT=$((60 * 60))  # 60 minutes max
ELAPSED=0
LAST_COUNT=0
STUCK_COUNT=0

while [ $ELAPSED -lt $EXPORT_TIMEOUT ]; do
  STATUS=$(curl -s "${SERVER_URL}/status" 2>/dev/null || echo '{}')
  PHASE=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('done',''))" 2>/dev/null || echo "")
  COUNT=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('videoFiles',0))" 2>/dev/null || echo "0")
  META=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metaExists',False))" 2>/dev/null || echo "False")

  if [ "$PHASE" = "export" ]; then
    ok "导出阶段完成！共 ${COUNT} 个视频文件"
    break
  fi

  # Progress indication
  if [ "$COUNT" != "$LAST_COUNT" ]; then
    log "已上传 ${COUNT} 个视频文件..."
    LAST_COUNT=$COUNT
    STUCK_COUNT=0
  else
    STUCK_COUNT=$((STUCK_COUNT + 1))
    if [ $STUCK_COUNT -gt 30 ]; then
      # 5 minutes with no progress
      if [ "$META" = "True" ] && [ "$COUNT" -gt 0 ]; then
        log "进度似乎已停止但元数据已保存，尝试继续..."
        break
      fi
    fi
  fi

  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

if [ $ELAPSED -ge $EXPORT_TIMEOUT ]; then
  err "导出超时（60分钟）"
  log "请手动检查 migration-data/ 目录"
  exit 1
fi

# Wait a moment for Edge to finish writing
sleep 3

# Final check
FINAL_STATUS=$(curl -s "${SERVER_URL}/status" 2>/dev/null || echo '{}')
FINAL_COUNT=$(echo "$FINAL_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('videoFiles',0))" 2>/dev/null || echo "0")
FINAL_META=$(echo "$FINAL_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metaExists',False))" 2>/dev/null || echo "False")

if [ "$FINAL_META" != "True" ] || [ "$FINAL_COUNT" -eq 0 ]; then
  err "导出数据不完整（meta=${FINAL_META}, videos=${FINAL_COUNT}）"
  exit 1
fi

TOTAL_MB=$(du -sm "${SCRIPT_DIR}/migration-data" 2>/dev/null | cut -f1 || echo "?")
ok "导出完成！共 ${FINAL_COUNT} 个文件，${TOTAL_MB} MB"

# ─── Step 3: Import into Electron ───────────────────────
log ""
log "=========================================="
log "  阶段 2/2: 导入到 Electron 应用"
log "=========================================="
log "正在启动 Electron..."

# Start Electron with --migrate flag for auto-import
cd "$SCRIPT_DIR"
unset ELECTRON_RUN_AS_NODE
"$ELECTRON_BIN" "$SCRIPT_DIR" --migrate &
ELECTRON_PID=$!
sleep 5

if ! kill -0 $ELECTRON_PID 2>/dev/null; then
  err "Electron 启动失败"
  exit 1
fi
ok "Electron 已启动 (PID: $ELECTRON_PID) — 正在自动导入..."

# Wait for import to complete
IMPORT_TIMEOUT=$((60 * 60))  # 60 minutes max
ELAPSED=0
LAST_COUNT=0
STUCK_COUNT=0

while [ $ELAPSED -lt $IMPORT_TIMEOUT ]; do
  STATUS=$(curl -s "${SERVER_URL}/status" 2>/dev/null || echo '{}')
  PHASE=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('done',''))" 2>/dev/null || echo "")

  if [ "$PHASE" = "import" ]; then
    IMPORT_COUNT=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo "0")
    ok "导入完成！共 ${IMPORT_COUNT} 个视频"
    break
  fi

  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

if [ $ELAPSED -ge $IMPORT_TIMEOUT ]; then
  err "导入超时（60分钟）"
  exit 1
fi

# ─── Done ───────────────────────────────────────────────
log ""
log "=========================================="
ok "🎉 数据迁移全部完成！"
log "=========================================="
log "你现在可以："
log "  1. 关闭此终端窗口"
log "  2. 重新启动「视频档案」应用"
log "  3. 所有视频和分组已导入"
log ""
log "migration-data/ 目录可安全删除（${TOTAL_MB} MB）"
log ""

# Keep Electron running (user may want to verify)
log "Electron 应用仍在运行，关闭此窗口不会影响它"
log "按 Ctrl+C 退出并清理..."
wait $ELECTRON_PID 2>/dev/null || true
