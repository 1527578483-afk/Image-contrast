# ShotSync — 视频搜集、分组、对比工具

浏览器端的视频管理与多路对比工具。支持将视频按场景分组，通过**自动音频对齐**和**手动音轨编辑器**实现跨设备拍摄素材的精准同步播放。

纯原生前端 SPA（无框架），IndexedDB 本地持久化。

## 核心功能

### 📂 视频管理
- 视频上传（支持拖拽），本地 IndexedDB 持久化存储
- 自定义分组 / 子分组（拍摄场景、机位），8 色自动标记
- 面包屑导航、视图缩放（`Ctrl` + `=` / `-` / `0`）
- **代理渲染**：将视频转码为 1080p 低分辨率代理，提升多路播放流畅度

### 🔁 多路对比
- 最多 8 路视频同屏对比（4×2 网格布局）
- 跨分组选取视频到对比槽位，拖拽交换槽位
- 视频旋转（90° 步进）、全屏单路放大
- 同步播放 / 暂停，进度条联动
- **导出**：Canvas + MediaRecorder 合成导出
  - 合成模式（多路合一）和分路模式（每路独立导出）
  - 可配置分辨率、帧率（含自定义）、格式（MP4 / WebM）
  - 可选叠加槽位名称水印

### 🎵 音频自动对齐
- 基于**能量包络 + 互相关**算法，自动计算各视频之间的时间偏移
- 支持跨设备对齐（iPhone ↔ Android / Vivo / Xiaomi）
- DC 偏移消除、起音点（onset）回退相关
- 并发音频提取，避免 Android 用户手势过期
- 对齐结果可视化（共同窗口、偏移量、可信度得分）

### ✏️ 手动音轨编辑器
- **波形可视化**：每路视频的能量包络波形（琥珀色）叠加在灰色时长条上
- **拖拽对齐**：直接在时间轴上拖拽音轨调整偏移
- **播放区间控制**：黄色区间条拖拽设置播放起止位置
- **缩放控制**：10%~1000% 时间轴缩放
- **播放光标**：播放时白色光标横跨所有音轨同步移动
- **交错播放模型**：支持音轨延迟起播（视频先冻结在首帧，到时间才开始播放）

### 📱 跨设备兼容
- iOS Safari / macOS Chrome — `AudioContext.decodeAudioData` 主方法
- Android Chrome（Vivo, Xiaomi 等）— `captureStream()` + `MediaRecorder` 回退
- 层叠回退策略：主方法 → 视频元素回退 → 无音轨标记

## 文件结构

```
├── index.html          # 主页面（所有 UI 由 JS 动态生成）
├── script.js           # 全部应用逻辑（~6100 行）
├── style.css           # 全局样式（~1200 行）
├── README.md           # 本文件
└── align_tool/         # 独立 Python 音频对齐后端
    ├── server.py       # FastAPI 服务
    ├── audio.py        # 音频处理逻辑
    ├── ffmpeg_utils.py # FFmpeg 工具封装
    ├── requirements.txt
    ├── run.sh / run.bat
    └── templates/
        └── index.html  # 对齐工具 Web UI
```

## 使用方式

### 主应用

直接在浏览器中打开 `index.html`，或部署到任意静态服务器：

```bash
# 本地快速启动
python3 -m http.server 8080
# 或
npx serve .
```

访问 `http://localhost:8080`。

> **注意**：数据存储在浏览器 IndexedDB 中，清除浏览器数据会导致视频丢失。

### 对齐工具（可选）

```bash
cd align_tool
pip install -r requirements.txt
bash run.sh        # macOS / Linux
# run.bat          # Windows
```

## 架构

```
┌─ viewGroups ────── 分组列表 / 网格
│   └─ 点击进入
├─ viewGroup ─────── 单组详情（子分组 + 视频卡片）
│   └─ 选取视频进入
├─ viewCompare ───── 多路对比视图
│   ├─ 视频槽位网格（4×2）
│   ├─ 音轨编辑器面板（时间轴 + 波形 + 区间条）
│   ├─ 全屏对比模式
│   └─ 导出模态框
└─ IndexedDB ─────── ShotSync v3
    ├─ objectStore: groups
    └─ objectStore: videos
```

## 版本历史

| 版本 | 标签 | 主要内容 |
|---|---|---|
| v1.0 | — | 视频上传、分组、基础对比 |
| v2.0 | `v2.0` | 音频对齐引擎重写：能量包络 + 互相关 |
| v3.0 | `v3.0` | 全屏进度条 + 跨设备音频对齐修复 |
| v4.0 | `v4.0` | 手动音轨编辑器 + Android 提取修复 + 槽位交换对齐 |

## 技术栈

| 技术 | 用途 |
|---|---|
| 原生 JS（ES2020+） | 无框架 SPA，三视图路由 |
| IndexedDB | 视频 + 分组数据持久化 |
| Web Audio API | 音频解码（`decodeAudioData`） |
| Canvas API | 波形渲染、视频导出合成 |
| MediaRecorder API | 音频回退提取、视频导出 |
| Pointer Events | 时间轴拖拽交互 |
| FastAPI + NumPy + SciPy | 独立音频对齐后端（`align_tool/`） |
