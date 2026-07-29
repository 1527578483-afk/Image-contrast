"""
server.py — 多机位视频音频对齐工具服务端

FastAPI 应用，提供：
  - 单文件前端页面（/）
  - 视频上传（/api/upload）
  - 音频分析（/api/analyze）
  - 对齐裁剪（/api/process）
  - 分屏合成（/api/compose，可选）
  - 文件下载（/api/download/{filename}）
  - 手动偏移调整（/api/manual-offset）

纯本地运行，不调用任何云端接口。
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from audio import AudioData, perform_alignment
from ffmpeg_utils import (
    compose_split_screen,
    extract_audio,
    generate_log,
    get_video_meta,
    trim_video_stream_copy,
)

# ---------------------------------------------------------------------------
# 应用初始化
# ---------------------------------------------------------------------------

app = FastAPI(
    title="多机位视频音频对齐工具",
    description="本地离线多机位视频音频对齐 — 基于 FFmpeg + NumPy/SciPy",
    version="1.0.0"
)

# 工作目录
WORK_DIR = Path(tempfile.gettempdir()) / "align_tool"
WORK_DIR.mkdir(parents=True, exist_ok=True)

# 清理超过 24 小时的旧会话
def _cleanup_old_sessions():
    """清理过期的工作目录（超过 24 小时）"""
    now = time.time()
    for child in WORK_DIR.iterdir():
        if child.is_dir():
            try:
                mtime = child.stat().st_mtime
                if now - mtime > 86400:  # 24 小时
                    shutil.rmtree(child, ignore_errors=True)
            except Exception:
                pass


_cleanup_old_sessions()

# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------

class AnalysisRequest(BaseModel):
    session_id: str
    manual_offsets: Optional[Dict[str, float]] = None  # 手动微调 {index: offset_sec}


class AnalysisResponse(BaseModel):
    success: bool
    reference_index: int = 0
    offsets: List[float] = []      # 每个视频的 seek 位置
    scores: List[float] = []       # 相关系数
    common_start: float = 0.0
    common_end: float = 0.0
    common_duration: float = 0.0
    rms_levels: List[float] = []   # dB 电平
    is_silent: List[bool] = []     # 是否静音
    durations: List[float] = []    # 视频时长
    message: str = ""


class ProcessRequest(BaseModel):
    session_id: str
    offsets: List[float]           # 可覆盖的偏移量
    common_duration: float
    compose_split: bool = False    # 是否生成分屏合成


class ProcessResponse(BaseModel):
    success: bool
    output_files: List[str] = []   # 输出文件名列表
    log_file: str = ""             # 日志文件名
    compose_file: str = ""         # 分屏文件名
    message: str = ""


class UploadResponse(BaseModel):
    success: bool
    session_id: str = ""
    files: List[dict] = []         # [{index, original_name, saved_name, size, duration, ...}]
    message: str = ""


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _get_session_dir(session_id: str) -> Path:
    """获取会话工作目录"""
    d = WORK_DIR / session_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _generate_session_id() -> str:
    """生成唯一会话 ID"""
    return uuid.uuid4().hex[:12]


# ---------------------------------------------------------------------------
# 静态文件 — 前端
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index():
    """返回前端页面"""
    html_path = Path(__file__).parent / "templates" / "index.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf-8")
    return """
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>对齐工具</title></head>
    <body><h1>前端页面未找到</h1><p>请检查 templates/index.html</p></body>
    </html>
    """


# ---------------------------------------------------------------------------
# API: 上传视频
# ---------------------------------------------------------------------------

@app.post("/api/upload", response_model=UploadResponse)
async def upload_videos(files: List[UploadFile] = File(...)):
    """
    上传多个视频文件。
    返回会话 ID 用于后续操作。
    """
    if not files:
        raise HTTPException(status_code=400, detail="未提供文件")

    session_id = _generate_session_id()
    session_dir = _get_session_dir(session_id)
    upload_dir = session_dir / "uploads"
    upload_dir.mkdir(exist_ok=True)

    saved_files = []

    for i, f in enumerate(files):
        if not f.filename:
            continue

        # 保留原始扩展名
        original_name = f.filename
        ext = Path(original_name).suffix.lower()
        if ext not in ('.mp4', '.mov', '.webm', '.mkv', '.avi', '.ts', '.m4v', '.mts'):
            ext = '.mp4'

        saved_name = f"video_{i}_{_safe_filename(Path(original_name).stem)}{ext}"
        saved_path = upload_dir / saved_name

        # 流式写入文件
        content = await f.read()
        saved_path.write_bytes(content)

        # 获取视频元信息
        try:
            meta = get_video_meta(str(saved_path))
            info = {
                "index": i,
                "original_name": original_name,
                "saved_name": saved_name,
                "size": saved_path.stat().st_size,
                "duration": meta.duration,
                "width": meta.width,
                "height": meta.height,
                "fps": meta.fps,
                "video_codec": meta.video_codec,
                "audio_codec": meta.audio_codec,
                "has_audio": meta.has_audio,
                "format_name": meta.format_name,
            }
        except Exception as e:
            info = {
                "index": i,
                "original_name": original_name,
                "saved_name": saved_name,
                "size": saved_path.stat().st_size,
                "duration": 0,
                "width": 0,
                "height": 0,
                "fps": 0,
                "video_codec": "",
                "audio_codec": "",
                "has_audio": False,
                "format_name": "",
                "error": str(e),
            }

        saved_files.append(info)

    return UploadResponse(
        success=True,
        session_id=session_id,
        files=saved_files,
        message=f"已上传 {len(saved_files)} 个视频"
    )


# ---------------------------------------------------------------------------
# API: 音频分析
# ---------------------------------------------------------------------------

@app.post("/api/analyze", response_model=AnalysisResponse)
async def analyze_audio(req: AnalysisRequest):
    """
    分析上传视频的音频，计算对齐偏移量。

    流程：
    1. 提取所有视频的音频为 WAV
    2. 计算能量包络 + 边界检测
    3. 互相关计算偏移量
    4. 计算共同时间窗口
    """
    session_dir = _get_session_dir(req.session_id)
    upload_dir = session_dir / "uploads"

    if not upload_dir.exists():
        raise HTTPException(status_code=404, detail="会话不存在或已过期，请重新上传")

    # 按 index 排列视频文件
    video_files = sorted(
        upload_dir.glob("video_*.*"),
        key=lambda p: int(p.stem.split('_')[1]) if '_' in p.stem else 0
    )

    if not video_files:
        raise HTTPException(status_code=400, detail="未找到视频文件")

    # 提取音频
    audio_dir = session_dir / "audio"
    audio_dir.mkdir(exist_ok=True)

    audio_data_list: List[AudioData] = []
    rms_levels = []
    is_silent = []
    durations = []

    for i, vp in enumerate(video_files):
        # 获取元信息
        try:
            meta = get_video_meta(str(vp))
            dur = meta.duration
        except Exception:
            dur = 0.0
        durations.append(dur)

        # 创建 AudioData
        ad = AudioData(index=i, filepath=str(vp), duration=dur)

        # 提取音频
        try:
            wav_path = extract_audio(str(vp), str(audio_dir))
            ad.wav_path = wav_path or ""
        except Exception as e:
            print(f"[Server] 槽位 {i} 音频提取失败: {e}")
            ad.wav_path = ""

        audio_data_list.append(ad)

    # 运行对齐引擎
    result = perform_alignment(audio_data_list, verbose=True)

    # 应用手动偏移覆盖
    if req.manual_offsets:
        for idx_str, off_val in req.manual_offsets.items():
            idx = int(idx_str)
            if 0 <= idx < len(result.offsets):
                print(f"[Server] 手动覆盖槽位 {idx}: {result.offsets[idx]:.3f}s → {off_val:.3f}s")
                result.offsets[idx] = off_val

    # 收集统计信息
    for ad in result.audio_data:
        rms_levels.append(ad.rms_db)
        is_silent.append(ad.is_silent)

    return AnalysisResponse(
        success=True,
        reference_index=result.reference_index,
        offsets=result.offsets,
        scores=result.scores,
        common_start=result.common_start,
        common_end=result.common_end,
        common_duration=result.common_duration,
        rms_levels=rms_levels,
        is_silent=is_silent,
        durations=durations,
        message=f"分析完成，参考: 槽位 {result.reference_index}，"
                f"共同窗口: {result.common_start:.2f}s–{result.common_end:.2f}s"
    )


# ---------------------------------------------------------------------------
# API: 执行裁剪
# ---------------------------------------------------------------------------

@app.post("/api/process", response_model=ProcessResponse)
async def process_videos(req: ProcessRequest):
    """
    使用流拷贝裁剪所有视频。

    参数可覆盖 analyze 阶段计算的偏移量。
    """
    session_dir = _get_session_dir(req.session_id)
    upload_dir = session_dir / "uploads"
    output_dir = session_dir / "output"
    output_dir.mkdir(exist_ok=True)

    if not upload_dir.exists():
        raise HTTPException(status_code=404, detail="会话不存在或已过期")

    video_files = sorted(
        upload_dir.glob("video_*.*"),
        key=lambda p: int(p.stem.split('_')[1]) if '_' in p.stem else 0
    )

    if not video_files:
        raise HTTPException(status_code=400, detail="未找到视频文件")

    n = len(video_files)
    offsets = req.offsets if len(req.offsets) >= n else [0.0] * n
    common_dur = req.common_duration

    output_files = []

    for i, vp in enumerate(video_files):
        offset = offsets[i]
        # 确保偏移合理
        offset = max(0.0, offset)

        ext = vp.suffix
        safe_name = _safe_filename(vp.stem)
        out_name = f"aligned_{i}_{safe_name}{ext}"
        out_path = output_dir / out_name

        print(f"[Server] 裁剪槽位 {i}: start={offset:.3f}s, duration={common_dur:.3f}s")

        try:
            trim_video_stream_copy(str(vp), str(out_path), offset, common_dur)
            output_files.append(out_name)
            print(f"[Server]   → {out_name} 完成")
        except Exception as e:
            print(f"[Server]   → 裁剪失败: {e}")
            # 如果裁剪失败，复制原文件作为降级方案
            shutil.copy2(vp, out_path)
            output_files.append(out_name + " (未裁剪，原文件)")
            print(f"[Server]   → 已复制原文件作为降级")

    # 生成日志
    # 构造一个简化的对齐结果用于日志
    from audio import AlignmentResult
    log_alignment = AlignmentResult(
        reference_index=0,
        common_start=offsets[0] if offsets else 0.0,
        common_end=(offsets[0] if offsets else 0.0) + common_dur,
        common_duration=common_dur,
        offsets=offsets,
        scores=[0.0] * n,
        audio_data=[]
    )

    log_path = generate_log(
        str(output_dir),
        [str(vp) for vp in video_files],
        log_alignment
    )
    log_name = os.path.basename(log_path)
    output_files.append(log_name)

    # 可选分屏合成
    compose_name = ""
    if req.compose_split and len(video_files) >= 2:
        try:
            compose_name = f"composite_{_generate_session_id()}.mp4"
            compose_path = output_dir / compose_name
            # 使用对齐后的文件
            aligned_files = [str(output_dir / f) for f in output_files[:n]]
            compose_split_screen(
                aligned_files,
                [0.0] * n,  # 已对齐，偏移为 0
                common_dur,
                str(compose_path)
            )
            output_files.append(compose_name)
            print(f"[Server] 分屏合成完成: {compose_name}")
        except Exception as e:
            print(f"[Server] 分屏合成失败: {e}")
            compose_name = ""

    return ProcessResponse(
        success=True,
        output_files=output_files,
        log_file=log_name,
        compose_file=compose_name,
        message=f"已处理 {n} 个视频，输出 {len(output_files)} 个文件"
    )


# ---------------------------------------------------------------------------
# API: 文件下载
# ---------------------------------------------------------------------------

@app.get("/api/download/{session_id}/{filename}")
async def download_file(session_id: str, filename: str):
    """
    下载处理后的文件。
    """
    session_dir = _get_session_dir(session_id)

    # 先在 output 目录找，再在 uploads 目录找
    for subdir in ['output', 'uploads']:
        file_path = session_dir / subdir / filename
        if file_path.exists() and file_path.is_file():
            return FileResponse(
                str(file_path),
                filename=filename,
                media_type='application/octet-stream'
            )

    raise HTTPException(status_code=404, detail="文件不存在")


# ---------------------------------------------------------------------------
# API: 手动偏移调整
# ---------------------------------------------------------------------------

class ManualOffsetRequest(BaseModel):
    session_id: str
    changes: Dict[str, float]  # {index_str: new_offset_sec}


@app.post("/api/manual-offset")
async def manual_offset(req: ManualOffsetRequest):
    """
    手动微调某条视频的偏移量。
    这只是一个便利端点，实际的偏移覆盖在 /api/analyze 请求中传递。
    """
    return {
        "success": True,
        "changes": req.changes,
        "message": "偏移量已记录，请在分析请求中提交 manual_offsets"
    }


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _safe_filename(name: str) -> str:
    """清理文件名，只保留安全字符"""
    return ''.join(c if c.isalnum() or c in '._- ' else '_' for c in name)[:64]


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    import uvicorn
    print("=" * 60)
    print("🎬 多机位视频音频对齐工具")
    print("=" * 60)
    print()
    print("  打开浏览器访问: http://localhost:8765")
    print("  按 Ctrl+C 停止服务")
    print()
    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="info")
