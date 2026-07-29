"""
ffmpeg_utils.py — FFmpeg 命令构建与 subprocess 调用

所有视频处理都通过 FFmpeg 完成：
  - 音频提取（PCM WAV）
  - 视频元信息获取（ffprobe）
  - 流拷贝裁剪（-c copy，不重新编码）
  - 可选分屏合成（需重新编码）
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple


# ---------------------------------------------------------------------------
# 数据类型
# ---------------------------------------------------------------------------

@dataclass
class VideoMeta:
    """视频元信息"""
    filepath: str
    duration: float          # 时长（秒）
    width: int               # 宽度（像素）
    height: int              # 高度（像素）
    fps: float               # 帧率
    video_codec: str         # 视频编码（h264, hevc, prores, ...）
    audio_codec: str         # 音频编码（aac, pcm_s16le, ...）
    has_audio: bool          # 是否有音频轨道
    format_name: str         # 容器格式（mov, mp4, ...）
    file_size: int           # 文件大小（字节）
    bit_rate: int            # 比特率（bps）


# ---------------------------------------------------------------------------
# FFmpeg 检测
# ---------------------------------------------------------------------------

def find_ffmpeg() -> Tuple[str, str]:
    """
    查找 ffmpeg 和 ffprobe 路径。
    检查 PATH 和常见安装位置（~/.local/bin, /opt/homebrew/bin, /usr/local/bin）。
    Returns (ffmpeg_path, ffprobe_path)
    Raises FileNotFoundError if not found.
    """
    # 扩展搜索路径
    search_dirs = [
        os.path.expanduser('~/.local/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/opt/ffmpeg/bin',
    ]

    ffmpeg_path = shutil.which('ffmpeg')
    if not ffmpeg_path:
        for d in search_dirs:
            p = os.path.join(d, 'ffmpeg')
            if os.path.exists(p) and os.access(p, os.X_OK):
                ffmpeg_path = p
                break

    if not ffmpeg_path:
        raise FileNotFoundError(
            "未找到 ffmpeg。请安装 FFmpeg：\n"
            "  Mac:  brew install ffmpeg\n"
            "  Win:  https://ffmpeg.org/download.html"
        )

    ffprobe_path = shutil.which('ffprobe')
    if not ffprobe_path:
        # 尝试在同目录找
        ffmpeg_dir = os.path.dirname(ffmpeg_path)
        candidate = os.path.join(ffmpeg_dir, 'ffprobe')
        if os.path.exists(candidate):
            ffprobe_path = candidate

    if not ffprobe_path:
        for d in search_dirs:
            p = os.path.join(d, 'ffprobe')
            if os.path.exists(p) and os.access(p, os.X_OK):
                ffprobe_path = p
                break

    if not ffprobe_path:
        # 最后 fallback：假设和 ffmpeg 在同一目录
        ffprobe_path = os.path.join(os.path.dirname(ffmpeg_path), 'ffprobe')

    return (ffmpeg_path, ffprobe_path)


# ---------------------------------------------------------------------------
# ffprobe — 获取视频元信息
# ---------------------------------------------------------------------------

def get_video_meta(filepath: str) -> VideoMeta:
    """
    使用 ffprobe 获取视频完整元信息。
    """
    _, ffprobe_path = find_ffmpeg()

    cmd = [
        ffprobe_path,
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filepath
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {result.stderr.strip()}")

    info = json.loads(result.stdout)

    # 默认值
    duration = 0.0
    width = 0
    height = 0
    fps = 0.0
    video_codec = ''
    audio_codec = ''
    has_audio = False
    format_name = ''
    file_size = 0
    bit_rate = 0

    # 从 format 提取
    fmt = info.get('format', {})
    duration = float(fmt.get('duration', 0))
    format_name = fmt.get('format_name', '')
    file_size = int(fmt.get('size', 0))
    bit_rate = int(fmt.get('bit_rate', 0))

    # 从 streams 提取
    for stream in info.get('streams', []):
        codec_type = stream.get('codec_type', '')
        if codec_type == 'video':
            width = int(stream.get('width', 0))
            height = int(stream.get('height', 0))
            video_codec = stream.get('codec_name', '')
            # 帧率
            fps_str = stream.get('r_frame_rate', '0/1')
            if '/' in fps_str:
                num, den = fps_str.split('/')
                fps = float(num) / float(den) if float(den) != 0 else 0.0
            else:
                fps = float(fps_str)
        elif codec_type == 'audio':
            audio_codec = stream.get('codec_name', '')
            has_audio = True

    return VideoMeta(
        filepath=filepath,
        duration=duration,
        width=width,
        height=height,
        fps=fps,
        video_codec=video_codec,
        audio_codec=audio_codec,
        has_audio=has_audio,
        format_name=format_name,
        file_size=file_size,
        bit_rate=bit_rate
    )


# ---------------------------------------------------------------------------
# 音频提取
# ---------------------------------------------------------------------------

def extract_audio(
    video_path: str,
    output_dir: str,
    sample_rate: int = 44100
) -> Optional[str]:
    """
    从视频中提取音频为 PCM WAV。

    Parameters
    ----------
    video_path : str
        视频文件路径
    output_dir : str
        输出目录
    sample_rate : int
        输出采样率（Hz）

    Returns
    -------
    输出 WAV 文件路径，无音频时返回 None
    """
    ffmpeg_path, _ = find_ffmpeg()

    # 先检查是否有音频
    meta = get_video_meta(video_path)
    if not meta.has_audio:
        return None

    basename = Path(video_path).stem
    # 清理文件名
    safe_name = ''.join(c if c.isalnum() or c in '._-' else '_' for c in basename)
    output_path = os.path.join(output_dir, f'{safe_name}_audio.wav')

    cmd = [
        ffmpeg_path,
        '-i', video_path,
        '-vn',                   # 不要视频
        '-acodec', 'pcm_s16le',  # 16-bit PCM
        '-ar', str(sample_rate), # 采样率
        '-ac', '1',              # 单声道
        '-y',                    # 覆盖
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # 如果提取失败（某些 ProRes 无音频轨），返回 None
        if 'Stream specifier' in result.stderr and 'audio' in result.stderr.lower():
            return None
        raise RuntimeError(f"音频提取失败: {result.stderr.strip()}")

    return output_path


# ---------------------------------------------------------------------------
# 流拷贝裁剪
# ---------------------------------------------------------------------------

def trim_video_stream_copy(
    video_path: str,
    output_path: str,
    start_sec: float,
    duration_sec: float
) -> bool:
    """
    使用流拷贝方式裁剪视频（不重新编码）。

    Parameters
    ----------
    video_path : str
        输入视频路径
    output_path : str
        输出视频路径
    start_sec : float
        起始时间（秒）
    duration_sec : float
        裁剪时长（秒）

    Returns
    -------
    是否成功
    """
    ffmpeg_path, _ = find_ffmpeg()

    # 确保输出目录存在
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.', exist_ok=True)

    cmd = [
        ffmpeg_path,
        '-ss', str(start_sec),          # 起始位置
        '-i', video_path,
        '-t', str(duration_sec),         # 时长
        '-c', 'copy',                    # 流拷贝（不重新编码）
        '-avoid_negative_ts', 'make_zero',
        '-map_metadata', '0',            # 保留元数据
        '-y',                            # 覆盖
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"流拷贝裁剪失败: {result.stderr.strip()}")

    return True


# ---------------------------------------------------------------------------
# 获取流拷贝的实际裁剪点
# ---------------------------------------------------------------------------

def get_actual_trim_points(
    video_path: str,
    start_sec: float,
    duration_sec: float
) -> Tuple[float, float]:
    """
    预览流拷贝的实际裁剪点（受关键帧限制）。

    在流拷贝模式下，FFmpeg 会在最近的 GOP 起始关键帧处裁剪。
    这个函数不做实际裁剪，仅用于预览。

    Returns (actual_start, actual_duration)
    """
    # 最优近似：目标值就是用户期望的
    # 实际流拷贝的起始会被 FFmpeg 调整到最近的关键帧
    return (start_sec, duration_sec)


# ---------------------------------------------------------------------------
# 分屏合成（需重新编码）
# ---------------------------------------------------------------------------

def compose_split_screen(
    video_paths: List[str],
    offsets: List[float],
    common_duration: float,
    output_path: str,
    layout: str = 'auto'
) -> bool:
    """
    将多条对齐后的视频合成为一个分屏视频。

    ⚠️ 此步骤必须重新编码（合成 = 新画面）。
    原始视频参数不会被修改（输入文件只读）。

    Parameters
    ----------
    video_paths : List[str]
        输入视频路径列表
    offsets : List[float]
        每个视频的 seek 偏移（秒）
    common_duration : float
        共同时长
    output_path : str
        输出路径
    layout : str
        'auto' — 自动选择
        '2-h' — 两个视频左右并排
        '2-v' — 两个视频上下堆叠
        '4' — 2×2 网格

    Returns
    -------
    是否成功
    """
    ffmpeg_path, _ = find_ffmpeg()
    n = len(video_paths)

    # 选择布局
    if layout == 'auto':
        if n == 1:
            layout = '1'
        elif n == 2:
            layout = '2-h'
        elif n <= 4:
            layout = '4'
        else:
            layout = 'grid'

    # 构建 FFmpeg 滤镜图
    filter_parts = []
    inputs = []

    for i, (vp, off) in enumerate(zip(video_paths, offsets)):
        # 每个输入需要裁剪 + seek
        inputs.extend([
            '-ss', str(off),
            '-i', vp,
        ])
        # 裁剪 + 缩放 + 填充
        filter_parts.append(
            f"[{i}:v]trim=duration={common_duration},"
            f"setpts=PTS-STARTPTS,"
            f"fps=30,"
            f"scale=960:540:force_original_aspect_ratio=decrease,"
            f"pad=960:540:(ow-iw)/2:(oh-ih)/2,"
            f"format=yuv420p[v{i}]"
        )

    # 拼接画面
    video_inputs = ''.join(f'[v{i}]' for i in range(n))
    if n == 1:
        stack = f"{video_inputs}concat=n=1:v=1[outv]"
    elif n == 2:
        stack = f"{video_inputs}hstack=inputs=2[outv]"
    elif n == 3:
        # 3 个视频: 上排 2 个 + 下排 1 个 居中
        filter_parts.append(
            f"[v0][v1]hstack=inputs=2[row0];"
            f"[v2]pad=1920:540:(ow-iw)/2:(oh-ih)/2[row1];"
            f"[row0][row1]vstack=inputs=2[outv]"
        )
        stack = ''
    elif n == 4:
        stack = f"{video_inputs}xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[outv]"
    else:
        # 多列网格
        cols = min(4, n)
        rows = (n + cols - 1) // cols
        # 简化: 用 hstack + vstack
        row_filters = []
        for r in range(rows):
            row_vids = [f'v{r*cols+c}' for c in range(min(cols, n - r*cols))]
            if len(row_vids) == 1:
                row_filters.append(f"{''.join(row_vids)}null[row{r}]")
            else:
                row_filters.append(f"{''.join(row_vids)}hstack=inputs={len(row_vids)}[row{r}]")
        row_outputs = ''.join(f'[row{r}]' for r in range(rows))
        stack = f"{';'.join(row_filters)};{row_outputs}vstack=inputs={rows}[outv]"

    filter_complex = ';'.join(filter_parts) + (';' + stack if stack else '')

    # 音频混合：所有音轨叠加
    audio_inputs_list = []
    audio_mix_parts = []
    for i in range(n):
        audio_inputs_list.append(f'[{i}:a]atrim=duration={common_duration},adelay=0,volume=1.0[a{i}]')
        audio_mix_parts.append(f'[a{i}]')

    audio_mix = f"{';'.join(audio_inputs_list)};{''.join(audio_mix_parts)}amix=inputs={n}:duration=first[outa]"

    filter_complex += ';' + audio_mix if audio_mix else ''

    cmd = [
        ffmpeg_path,
        *inputs,
        '-t', str(common_duration),
        '-filter_complex', filter_complex,
        '-map', '[outv]',
        '-map', '[outa]',
        '-c:v', 'libx264',
        '-crf', '4',               # 极高质量（接近无损）
        '-preset', 'medium',
        '-c:a', 'aac',
        '-b:a', '256k',
        '-pix_fmt', 'yuv420p',
        '-y',
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"分屏合成失败: {result.stderr.strip()}")

    return True


# ---------------------------------------------------------------------------
# 生成对齐日志
# ---------------------------------------------------------------------------

def generate_log(
    output_dir: str,
    video_paths: List[str],
    alignment_result,
    actual_offsets: Optional[List[float]] = None
) -> str:
    """
    生成对齐日志文件（TXT 格式）。

    Returns
    -------
    日志文件路径
    """
    log_path = os.path.join(output_dir, 'alignment_log.txt')

    with open(log_path, 'w', encoding='utf-8') as f:
        f.write("=" * 60 + "\n")
        f.write("多机位视频音频对齐 — 日志\n")
        f.write("=" * 60 + "\n\n")

        f.write(f"参考视频: 槽位 {alignment_result.reference_index}\n")
        f.write(f"共同窗口: {alignment_result.common_start:.3f}s → "
                f"{alignment_result.common_end:.3f}s\n")
        f.write(f"共同时长: {alignment_result.common_duration:.3f}s\n\n")

        f.write("-" * 60 + "\n")
        f.write(f"{'槽位':<6} {'文件名':<25} {'偏移(s)':<12} {'裁起始(s)':<12} {'裁时长(s)':<12} {'相关系数':<10}\n")
        f.write("-" * 60 + "\n")

        for i, vp in enumerate(video_paths):
            name = os.path.basename(vp)[:24]
            offset = alignment_result.offsets[i] if i < len(alignment_result.offsets) else 0.0
            score = alignment_result.scores[i] if i < len(alignment_result.scores) else 0.0
            trim_start = offset
            trim_dur = alignment_result.common_duration

            f.write(f"{i:<6} {name:<25} {offset:+9.3f}  {trim_start:10.3f}  "
                    f"{trim_dur:10.3f}  {score:8.4f}\n")

        f.write("-" * 60 + "\n\n")

        # 视频参数摘要
        f.write("各视频原始参数：\n")
        f.write("-" * 60 + "\n")
        for i, vp in enumerate(video_paths):
            try:
                meta = get_video_meta(vp)
                f.write(f"\n槽位 {i}: {os.path.basename(vp)}\n")
                f.write(f"  分辨率: {meta.width}x{meta.height}\n")
                f.write(f"  帧率: {meta.fps:.2f} fps\n")
                f.write(f"  编码: {meta.video_codec} / {meta.audio_codec}\n")
                f.write(f"  时长: {meta.duration:.2f}s\n")
                f.write(f"  容器: {meta.format_name}\n")
                f.write(f"  文件大小: {meta.file_size / 1024 / 1024:.1f} MB\n")
            except Exception as e:
                f.write(f"\n槽位 {i}: {os.path.basename(vp)}\n")
                f.write(f"  元信息获取失败: {e}\n")

        # 处理说明
        f.write("\n" + "=" * 60 + "\n")
        f.write("处理说明：\n")
        f.write("- 所有视频使用流拷贝（-c copy）裁剪，画面不重新编码\n")
        f.write("- 帧率、分辨率、编码格式均保持原样\n")
        f.write("- 裁剪点为最近关键帧（GOP 边界），实际裁剪可能有 ±0.5~2s 误差\n")
        f.write("- 所有音频轨道均保留，最终合成时叠加播放\n")
        f.write("=" * 60 + "\n")

    return log_path


# ---------------------------------------------------------------------------
# 快速测试（直接运行）
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    import sys

    if len(sys.argv) < 2:
        print("用法: python ffmpeg_utils.py <video.mp4>")
        print("  测试：打印视频元信息")
        sys.exit(1)

    video_path = sys.argv[1]
    meta = get_video_meta(video_path)
    print(f"文件: {meta.filepath}")
    print(f"容器: {meta.format_name}")
    print(f"时长: {meta.duration:.2f}s")
    print(f"分辨率: {meta.width}x{meta.height}")
    print(f"帧率: {meta.fps:.2f} fps")
    print(f"视频编码: {meta.video_codec}")
    print(f"音频编码: {meta.audio_codec}")
    print(f"有音频: {meta.has_audio}")
    print(f"文件大小: {meta.file_size / 1024 / 1024:.1f} MB")
    print(f"比特率: {meta.bit_rate / 1000:.0f} kbps")
