#!/bin/bash
cd "$(dirname "$0")"
export PATH="$HOME/.local/node-v20.19.4-darwin-arm64/bin:$PATH"
echo "正在启动数据迁移服务器..."
echo ""
node migrate-server.js
echo ""
echo "服务器已停止。"
read -p "按 Enter 键关闭此窗口..."
