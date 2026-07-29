#!/bin/bash
# 多机位视频音频对齐工具 — Mac 启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo "❌ 未找到 python3，请先安装 Python 3.9+"
    echo "   brew install python3"
    exit 1
fi

# 检查 FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "❌ 未找到 ffmpeg，请先安装 FFmpeg"
    echo "   brew install ffmpeg"
    exit 1
fi

# 安装依赖（如需要）
if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "📦 正在安装 Python 依赖..."
    pip3 install -r requirements.txt
fi

echo "🚀 启动多机位音频对齐工具..."
echo "   浏览器将自动打开 http://localhost:8765"
echo "   按 Ctrl+C 停止服务"
echo ""

# 自动打开浏览器
sleep 1 && open http://localhost:8765 2>/dev/null &

python3 server.py
