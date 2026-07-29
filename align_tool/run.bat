@echo off
REM 多机位视频音频对齐工具 — Windows 启动脚本
cd /d "%~dp0"

REM 检查 Python
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] 未找到 python，请先安装 Python 3.9+
    echo     https://www.python.org/downloads/
    pause
    exit /b 1
)

REM 检查 FFmpeg
where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] 未找到 ffmpeg，请先安装 FFmpeg
    echo     https://ffmpeg.org/download.html
    pause
    exit /b 1
)

REM 安装依赖（如需要）
python -c "import fastapi" >nul 2>nul
if %errorlevel% neq 0 (
    echo [>] 正在安装 Python 依赖...
    pip install -r requirements.txt
)

echo [>] 启动多机位音频对齐工具...
echo     浏览器将自动打开 http://localhost:8765
echo     按 Ctrl+C 停止服务
echo.

REM 自动打开浏览器
start http://localhost:8765

python server.py
pause
