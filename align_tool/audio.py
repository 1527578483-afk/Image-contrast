"""
audio.py — 音频波形分析核心模块

多机位视频对齐的核心算法：
  - 能量包络计算（RMS over sliding windows）
  - 内容边界检测（基于自适应能量阈值）
  - Pearson 归一化互相关（能量包络级别）
  - 5 阶段对齐管道

算法移植自已验证的 JavaScript 实现，所有符号约定保持一致。
"""

from __future__ import annotations

import math
import struct
import wave
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np
from scipy import signal

# ---------------------------------------------------------------------------
# 数据类型
# ---------------------------------------------------------------------------

@dataclass
class Envelope:
    """能量包络"""
    energies: np.ndarray       # RMS 能量数组（float32）
    window_rate: float         # 包络采样率 = sample_rate / window_size


@dataclass
class AudioData:
    """单条视频的音频分析数据"""
    index: int                 # 槽位索引
    filepath: str              # 原始视频路径
    wav_path: str = ""         # 提取出的 WAV 路径
    samples: Optional[np.ndarray] = None   # 音频采样（float64, -1..1）
    sample_rate: int = 0       # 采样率（Hz）
    duration: float = 0.0      # 音频时长（秒）

    # 分析结果
    is_silent: bool = False    # 是否为静音视频
    rms_db: float = -100.0     # RMS 电平（dB）
    content_start: float = 0.0 # 内容开始时间（秒）
    content_end: float = 0.0   # 内容结束时间（秒）
    corr_offset: float = 0.0   # 相对于参考的偏移量（秒），正=滞后
    corr_score: float = 0.0    # 相关系数（0..1）


@dataclass
class AlignmentResult:
    """对齐结果"""
    reference_index: int       # 参考视频的槽位索引
    common_start: float        # 共同窗口起始（秒，在参考时间轴上）
    common_end: float          # 共同窗口结束（秒，在参考时间轴上）
    common_duration: float     # 共同窗口时长（秒）
    offsets: List[float]       # 每个视频的 seek 位置（秒）
    scores: List[float]        # 每个视频与参考的相关系数
    audio_data: List[AudioData] = field(default_factory=list)


# ---------------------------------------------------------------------------
# WAV 文件加载
# ---------------------------------------------------------------------------

def load_wav(filepath: str) -> Tuple[np.ndarray, int]:
    """
    读取 WAV 文件，返回 (samples, sample_rate)。
    samples 归一化到 [-1, 1] 的 float64 数组。
    支持 PCM 16/24/32-bit 和 32-bit float。
    """
    with wave.open(filepath, 'rb') as wf:
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        nframes = wf.getnframes()

        raw = wf.readframes(nframes)

    # 根据采样宽度解码
    if sampwidth == 2:
        # 16-bit signed int
        fmt = f'<{nframes * nchannels}h'
        data = np.array(struct.unpack(fmt, raw), dtype=np.float64)
        data = data / 32768.0
    elif sampwidth == 3:
        # 24-bit signed int（少见但支持）
        data = _decode_pcm24(raw, nframes, nchannels)
    elif sampwidth == 4:
        # 32-bit signed int 或 float
        # 先尝试 int32
        fmt = f'<{nframes * nchannels}i'
        data = np.array(struct.unpack(fmt, raw), dtype=np.float64)
        data = data / 2147483648.0
    else:
        raise ValueError(f"不支持的位深度: {sampwidth} bytes/sample")

    # 如果多声道，取平均值转为单声道
    if nchannels > 1:
        data = data.reshape(-1, nchannels).mean(axis=1)

    # 确保一维
    data = data.ravel()

    return data.astype(np.float64), sample_rate


def _decode_pcm24(raw: bytes, nframes: int, nchannels: int) -> np.ndarray:
    """解码 24-bit PCM 为 float64[-1, 1]"""
    total_samples = nframes * nchannels
    # 每 3 字节一个采样
    samples = np.zeros(total_samples, dtype=np.int32)
    for i in range(total_samples):
        b0 = raw[i * 3]
        b1 = raw[i * 3 + 1]
        b2 = raw[i * 3 + 2]
        # 小端序
        val = b0 | (b1 << 8) | (b2 << 16)
        # 符号扩展
        if val >= 0x800000:
            val -= 0x1000000
        samples[i] = val
    return samples.astype(np.float64) / 8388608.0


# ---------------------------------------------------------------------------
# 能量包络
# ---------------------------------------------------------------------------

def compute_energy_envelope(
    samples: np.ndarray,
    sample_rate: int,
    window_ms: float = 200.0
) -> Envelope:
    """
    计算 RMS 能量包络。

    Parameters
    ----------
    samples : np.ndarray
        音频采样数组（float64）
    sample_rate : int
        采样率（Hz）
    window_ms : float
        窗口大小（毫秒）

    Returns
    -------
    Envelope
    """
    window_size = int(sample_rate * window_ms / 1000.0)

    if window_size < 1 or len(samples) < window_size:
        rms = float(np.sqrt(np.mean(samples ** 2)))
        return Envelope(
            energies=np.array([rms], dtype=np.float32),
            window_rate=1.0
        )

    num_windows = len(samples) // window_size
    # 截断到窗口对齐
    trimmed = samples[:num_windows * window_size]
    # 重塑为二维数组 (num_windows, window_size)
    shaped = trimmed.reshape(num_windows, window_size)
    # 向量化 RMS 计算
    energies = np.sqrt(np.mean(shaped ** 2, axis=1))

    window_rate = sample_rate / window_size
    return Envelope(
        energies=energies.astype(np.float32),
        window_rate=window_rate
    )


# ---------------------------------------------------------------------------
# RMS 电平（dB）
# ---------------------------------------------------------------------------

def compute_rms_db(samples: np.ndarray) -> float:
    """计算 RMS 电平（dB），用于选择参考基准。"""
    if len(samples) == 0:
        return -100.0
    rms = float(np.sqrt(np.mean(samples ** 2)))
    if rms < 1e-10:
        return -100.0
    return 20.0 * math.log10(rms)


# ---------------------------------------------------------------------------
# 内容边界检测
# ---------------------------------------------------------------------------

def detect_content_boundaries(env: Envelope) -> Tuple[float, float]:
    """
    根据能量包络检测内容的开始和结束位置。

    使用 loud-third median × 0.15 作为阈值，找到第一个和最后一个
    超过阈值的窗口。

    Returns
    -------
    (start_seconds, end_seconds)
    """
    energies = env.energies
    window_rate = env.window_rate

    if window_rate <= 0 or len(energies) < 2:
        duration = len(energies) / window_rate if window_rate > 0 else 1.0
        return (0.0, duration)

    # 取能量最高的 1/3 的中位数作为参考
    sorted_energies = np.sort(energies)
    loud_third = sorted_energies[int(len(energies) * 0.67):]
    median_loud = float(np.median(loud_third)) if len(loud_third) > 0 else 0.005
    threshold = max(0.005, median_loud * 0.15)

    # 从左找第一个超过阈值的位置
    content_start = 0.0
    above = np.where(energies > threshold)[0]
    if len(above) > 0:
        content_start = float(above[0]) / window_rate

    # 从右找最后一个超过阈值的位置
    content_end = len(energies) / window_rate
    if len(above) > 0:
        content_end = float(above[-1] + 1) / window_rate

    # 50ms 余量
    content_start = max(0.0, content_start - 0.05)
    content_end = min(len(energies) / window_rate, content_end + 0.05)

    return (content_start, content_end)


# ---------------------------------------------------------------------------
# 互相关（Pearson 归一化）
# ---------------------------------------------------------------------------

def correlate_envelopes(
    ref_env: Envelope,
    tgt_env: Envelope,
    window_rate: float,
    max_drift_secs: float = 8.0
) -> Tuple[float, float]:
    """
    对两条能量包络做 Pearson 归一化互相关。

    Parameters
    ----------
    ref_env : Envelope
        参考包络
    tgt_env : Envelope
        目标包络
    window_rate : float
        包络采样率
    max_drift_secs : float
        最大搜索偏移（秒）

    Returns
    -------
    (offset_seconds, score)
        offset > 0: tgt 比 ref 滞后
        offset < 0: tgt 比 ref 提前
        ref[t + offset] ≈ tgt[t]
    """
    ref = ref_env.energies.astype(np.float64)
    tgt = tgt_env.energies.astype(np.float64)

    max_lag = int(window_rate * max_drift_secs)
    if max_lag < 1:
        return (0.0, 0.0)

    best_offset = 0
    best_score = -float('inf')

    # 滑动窗口 Pearson 相关
    for lag in range(-max_lag, max_lag + 1):
        # overlap 区域
        overlap_start = max(0, lag)
        overlap_end = min(len(tgt), len(ref) + lag)
        n = overlap_end - overlap_start

        min_overlap = max(3, int(window_rate * 0.5))
        if n < min_overlap:
            continue

        ref_slice = ref[overlap_start - lag: overlap_end - lag]
        tgt_slice = tgt[overlap_start: overlap_end]

        # Pearson 相关系数
        ref_mean = np.mean(ref_slice)
        tgt_mean = np.mean(tgt_slice)

        ref_centered = ref_slice - ref_mean
        tgt_centered = tgt_slice - tgt_mean

        cov = np.sum(ref_centered * tgt_centered)
        var_ref = np.sum(ref_centered ** 2)
        var_tgt = np.sum(tgt_centered ** 2)

        if var_ref > 0 and var_tgt > 0:
            score = cov / np.sqrt(var_ref * var_tgt)
        else:
            score = 0.0

        if score > best_score:
            best_score = score
            best_offset = lag

    offset_sec = best_offset / window_rate
    return (offset_sec, float(best_score))


# ---------------------------------------------------------------------------
# 使用 scipy.signal.correlate 的快速互相关（备选方案）
# ---------------------------------------------------------------------------

def correlate_envelopes_fft(
    ref_env: Envelope,
    tgt_env: Envelope,
    window_rate: float,
    max_drift_secs: float = 8.0
) -> Tuple[float, float]:
    """
    使用 FFT 快速互相关的备选实现。
    在长音频上可能更快。
    """
    ref = ref_env.energies.astype(np.float64)
    tgt = tgt_env.energies.astype(np.float64)

    # 去均值（用于 Pearson 相关的协方差部分）
    ref_demean = ref - np.mean(ref)
    tgt_demean = tgt - np.mean(tgt)

    # 全长互相关
    correlation = signal.correlate(ref_demean, tgt_demean, mode='full')

    # 归一化因子（简化版）
    ref_var = np.sum(ref_demean ** 2)
    tgt_var = np.sum(tgt_demean ** 2)
    denom = np.sqrt(ref_var * tgt_var)

    # lags 数组: correlation[k] 对应 lag = k - (len(tgt) - 1)
    # 即 tgt[0] 和 ref[lag] 对齐
    lags = np.arange(-len(tgt) + 1, len(ref))

    max_lag_samples = int(window_rate * max_drift_secs)
    mask = np.abs(lags) <= max_lag_samples

    if denom > 0:
        scores = correlation / denom
    else:
        scores = np.zeros_like(correlation, dtype=np.float64)

    # 在允许范围内找最大值
    valid_scores = np.where(mask, scores, -np.inf)
    if len(valid_scores) == 0:
        return (0.0, 0.0)

    best_idx = int(np.argmax(valid_scores))
    best_lag = lags[best_idx]
    best_score = float(scores[best_idx])

    # 转换符号：correlate(ref, tgt) 中 lag = ref_index - tgt_index
    # 即 tgt[0] ≈ ref[lag], ref[t + offset] ≈ tgt[t] => offset = lag
    offset_sec = float(best_lag) / window_rate

    return (offset_sec, best_score)


# ---------------------------------------------------------------------------
# 5 阶段对齐管道
# ---------------------------------------------------------------------------

def perform_alignment(
    audio_data_list: List[AudioData],
    max_drift_secs: float = 8.0,
    verbose: bool = True
) -> AlignmentResult:
    """
    执行完整的 5 阶段音频对齐管道。

    Phase 1: 加载 WAV 音频文件
    Phase 2: 计算能量包络 + 内容边界 + 静音检测
    Phase 3: 互相关（以 SNR 最高的为参考）
    Phase 4: 找共同时间窗口
    Phase 5: 计算每个视频的 seek 位置

    Parameters
    ----------
    audio_data_list : List[AudioData]
        每个视频的音频数据（需要 wav_path 已设置）
    max_drift_secs : float
        最大搜索偏移量
    verbose : bool
        是否打印详细日志

    Returns
    -------
    AlignmentResult
    """
    n = len(audio_data_list)

    # ── Phase 1: 加载音频 ──────────────────────────────────
    if verbose:
        print(f"\n{'='*60}")
        print(f"[AudioAlign] Phase 1: 加载 {n} 条音频")
        print(f"{'='*60}")

    for data in audio_data_list:
        if not data.wav_path:
            print(f"[AudioAlign]  槽位 {data.index}: 无 WAV 文件，标记为静音")
            data.is_silent = True
            data.rms_db = -100.0
            continue
        try:
            samples, sr = load_wav(data.wav_path)
            data.samples = samples
            data.sample_rate = sr
            data.duration = len(samples) / sr
            if verbose:
                print(f"[AudioAlign]  槽位 {data.index}: 已加载, "
                      f"sr={sr}Hz, dur={data.duration:.2f}s, "
                      f"samples={len(samples)}")
        except Exception as e:
            print(f"[AudioAlign]  槽位 {data.index}: 加载失败 ({e})，标记为静音")
            data.is_silent = True
            data.rms_db = -100.0

    # ── Phase 2: 能量包络 + 边界 + 静音检测 ──────────────────
    if verbose:
        print(f"\n[AudioAlign] Phase 2: 能量包络 + 边界检测")

    SILENT_THRESHOLD = 0.0005  # 峰值能量低于此值视为静音
    audible: List[AudioData] = []

    for data in audio_data_list:
        if data.is_silent or data.samples is None:
            continue

        data.rms_db = compute_rms_db(data.samples)

        # 粗糙包络（200ms 窗口）
        env_200 = compute_energy_envelope(data.samples, data.sample_rate, 200)
        peak_energy = float(np.max(env_200.energies)) if len(env_200.energies) > 0 else 0.0

        if peak_energy < SILENT_THRESHOLD:
            data.is_silent = True
            data.content_start = 0.0
            data.content_end = data.duration
            if verbose:
                print(f"[AudioAlign]  槽位 {data.index}: ⚠️ 视频无声 "
                      f"(peak={peak_energy*1000:.1f}e-3, RMS={data.rms_db:.1f}dB)")
        else:
            data.is_silent = False
            # 精细包络（50ms 窗口）用于边界检测
            env_fine = compute_energy_envelope(data.samples, data.sample_rate, 50)
            start_s, end_s = detect_content_boundaries(env_fine)
            data.content_start = start_s
            data.content_end = end_s
            audible.append(data)
            if verbose:
                print(f"[AudioAlign]  槽位 {data.index}: 有声, "
                      f"peak={peak_energy*1000:.1f}e-3, RMS={data.rms_db:.1f}dB, "
                      f"内容: {start_s:.2f}s–{end_s:.2f}s")

    # ── Phase 3: 互相关 ─────────────────────────────────
    if verbose:
        print(f"\n[AudioAlign] Phase 3: 互相关 (有声视频 {len(audible)} 个)")

    if len(audible) < 2:
        if verbose:
            print("[AudioAlign]  有声视频不足 2 个，跳过互相关")
        # 所有视频 offset 设为 0
        offsets = [0.0] * n
        return AlignmentResult(
            reference_index=0,
            common_start=0.0,
            common_end=min(d.duration for d in audio_data_list if d.duration > 0),
            common_duration=min(d.duration for d in audio_data_list if d.duration > 0),
            offsets=offsets,
            scores=[0.0] * n,
            audio_data=audio_data_list
        )

    # 选择 SNR 最高的作为参考
    best_rms = -100.0
    ref_idx = 0
    for data in audible:
        if data.rms_db > best_rms:
            best_rms = data.rms_db
            ref_idx = data.index

    if verbose:
        print(f"[AudioAlign]  参考基准: 槽位 {ref_idx} (RMS={best_rms:.1f}dB)")

    # 为参考计算能量包络（200ms）
    ref_data = next(d for d in audible if d.index == ref_idx)
    ref_env = compute_energy_envelope(ref_data.samples, ref_data.sample_rate, 200)
    window_rate = ref_env.window_rate

    # 对其他视频做互相关
    corr_offsets: dict = {}
    corr_scores: dict = {}

    corr_offsets[ref_idx] = 0.0
    corr_scores[ref_idx] = 1.0

    for data in audible:
        if data.index == ref_idx:
            continue
        tgt_env = compute_energy_envelope(data.samples, data.sample_rate, 200)

        # 使用滑动窗口 Pearson 相关
        offset, score = correlate_envelopes(ref_env, tgt_env, window_rate, max_drift_secs)

        # 如果相关系数太低，尝试 FFT 方法
        if score < 0.3:
            offset2, score2 = correlate_envelopes_fft(ref_env, tgt_env, window_rate, max_drift_secs)
            if score2 > score:
                offset, score = offset2, score2

        corr_offsets[data.index] = offset
        corr_scores[data.index] = score
        data.corr_offset = offset
        data.corr_score = score

        if verbose:
            direction = "滞后" if offset > 0 else "提前" if offset < 0 else "同步"
            print(f"[AudioAlign]  槽位 {data.index}: "
                  f"offset={offset:+.3f}s ({direction}), "
                  f"相关系数={score:.3f}")

    # ── Phase 4: 共同时间窗口 ────────────────────────────
    if verbose:
        print(f"\n[AudioAlign] Phase 4: 共同时间窗口")

    # 对每个有声视频：把 contentStart/contentEnd 映射到参考时间轴
    # 映射公式: time_on_ref_timeline = own_time - corr_offset
    common_start = 0.0
    common_end = float('inf')

    for data in audible:
        corr = corr_offsets.get(data.index, 0.0)
        adj_start = data.content_start - corr
        adj_end = data.content_end - corr

        if verbose:
            print(f"[AudioAlign]  槽位 {data.index}: "
                  f"内容={data.content_start:.2f}–{data.content_end:.2f}s, "
                  f"offset={corr:+.3f}s → 参考时间轴={adj_start:.2f}–{adj_end:.2f}s")

        if adj_start > common_start:
            common_start = adj_start
        if adj_end < common_end:
            common_end = adj_end

    # 静音视频不参与共同窗口计算

    if common_end <= common_start:
        if verbose:
            print(f"[AudioAlign]  ⚠️ 共同窗口无效 ({common_start:.2f}–{common_end:.2f}), 使用默认值")
        common_start = 0.0
        common_end = min(d.duration for d in audio_data_list if d.duration > 0)

    common_duration = common_end - common_start

    if verbose:
        print(f"[AudioAlign]  共同窗口（有声视频）: {common_start:.2f}s → {common_end:.2f}s "
              f"(时长 {common_duration:.2f}s)")

    # ── Phase 5: 计算 seek 位置 ───────────────────────────
    if verbose:
        print(f"\n[AudioAlign] Phase 5: 计算 seek 位置")

    offsets = [0.0] * n

    for data in audible:
        corr = corr_offsets.get(data.index, 0.0)
        # seek_i = commonStart + corrOffset_i
        seek = common_start + corr
        seek = max(0.0, seek)
        offsets[data.index] = seek
        if verbose:
            print(f"[AudioAlign]  槽位 {data.index} (有声): seek→{seek:.2f}s")

    for data in audio_data_list:
        if data.is_silent:
            offsets[data.index] = 0.0
            if verbose:
                print(f"[AudioAlign]  槽位 {data.index} (静音): seek→0.00s")

    # 构建 scores 列表
    scores_list = [corr_scores.get(i, 0.0) for i in range(n)]

    if verbose:
        print(f"\n[AudioAlign] ✓ 对齐完成")
        print(f"[AudioAlign]  参考: 槽位 {ref_idx}")
        print(f"[AudioAlign]  共同窗口: {common_start:.2f}s → {common_end:.2f}s")
        print(f"[AudioAlign]  seek 位置: {[f'{o:.2f}s' for o in offsets]}")

    return AlignmentResult(
        reference_index=ref_idx,
        common_start=common_start,
        common_end=common_end,
        common_duration=common_duration,
        offsets=offsets,
        scores=scores_list,
        audio_data=audio_data_list
    )


# ---------------------------------------------------------------------------
# 快速测试（直接运行 python audio.py）
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    import sys

    if len(sys.argv) < 3:
        print("用法: python audio.py <ref.wav> <tgt.wav>")
        print("  测试两个 WAV 文件的互相关偏移量")
        sys.exit(1)

    ref_path = sys.argv[1]
    tgt_path = sys.argv[2]

    ref_samples, ref_sr = load_wav(ref_path)
    tgt_samples, tgt_sr = load_wav(tgt_path)

    print(f"参考: {ref_path}")
    print(f"  采样率: {ref_sr} Hz, 时长: {len(ref_samples)/ref_sr:.2f}s")
    print(f"目标: {tgt_path}")
    print(f"  采样率: {tgt_sr} Hz, 时长: {len(tgt_samples)/tgt_sr:.2f}s")

    ref_env = compute_energy_envelope(ref_samples, ref_sr, 200)
    tgt_env = compute_energy_envelope(tgt_samples, tgt_sr, 200)

    window_rate = ref_env.window_rate
    offset, score = correlate_envelopes(ref_env, tgt_env, window_rate)

    print(f"\n互相关结果（滑动窗口 Pearson）:")
    print(f"  偏移量: {offset:+.3f}s")
    print(f"  相关系数: {score:.4f}")

    offset2, score2 = correlate_envelopes_fft(ref_env, tgt_env, window_rate)
    print(f"\n互相关结果（FFT）:")
    print(f"  偏移量: {offset2:+.3f}s")
    print(f"  相关系数: {score2:.4f}")
