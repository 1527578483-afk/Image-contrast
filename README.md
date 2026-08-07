# FilmArchive — 视频搜集、分组、对比工具

浏览器端的视频管理与多路对比工具。支持将视频按场景分组，通过**自动音频对齐**和**手动音轨编辑器**实现跨设备拍摄素材的精准同步播放。

## 核心功能

### 📂 视频管理
- 视频上传（支持拖拽），本地 IndexedDB 持久化存储
- 自定义分组（拍摄场景 / 机位），颜色标记
- 视频代理渲染（降低分辨率以便多路同时播放）

### 🔁 多路对比
- 最多 8 路视频同屏对比
- 视频旋转（90° 步进）、全屏单路放大
- 同步播放 / 暂停，进度条联动
- **导出**：多路合成视频导出（Canvas + MediaRecorder）

### 🎵 音频自动对齐
- 基于**能量包络 + 互相关**算法，自动计算各视频之间的时间偏移
- 支持跨设备对齐（iPhone ↔ Android / Vivo / Xiaomi）
- DC 偏移消除、起音点（onset）回退相关
- 对齐结果可视化（共同窗口、偏移量、得分）

### ✏️ 手动音轨编辑器
- **波形可视化**：每路视频的能量包络波形（琥珀色）叠加在灰色时长条上
- **拖拽对齐**：直接在时间轴上拖拽音轨调整偏移
- **播放区间控制**：黄色区间条设置播放起止位置
- **缩放控制**：10%~1000% 时间轴缩放
- **播放光标**：播放时白色光标横跨所有音轨同步移动

### 📱 跨设备兼容
- iOS Safari / macOS Chrome — AudioContext.decodeAudioData 主方法
- Android Chrome（Vivo, Xiaomi 等）— captureStream + MediaRecorder 回退
- 并发音频提取，避免用户手势过期

## 文件结构

```
├── index.html    # 主页面（SPA，所有 UI 由 JS 动态生成）
├── script.js     # 全部应用逻辑（~6100 行）
├── style.css     # 全局样式（~3200 行）
└── README.md     # 本文件
```

## 使用方式

直接在浏览器中打开 `index.html`，或部署到任意静态服务器。

```bash
# 本地快速启动（Python）
python3 -m http.server 8080

# 或使用 Node.js
npx serve .
```

然后访问 `http://localhost:8080`。

> **注意**：数据存储在浏览器 IndexedDB 中，清除浏览器数据会导致视频丢失。

## 版本历史

| 版本 | 标签 | 主要内容 |
|---|---|---|
| v1.0 | — | 视频上传、分组、基础对比 |
| v2.0 | `v2.0` | 音频对齐引擎重写：能量包络 + 互相关 |
| v3.0 | `v3.0` | 全屏进度条 + 跨设备音频对齐修复 |
| v4.0 | `v4.0` | 手动音轨编辑器 + Android 提取修复 + 槽位交换对齐 |

## 技术栈

- 原生 HTML / CSS / JavaScript（无框架）
- IndexedDB（数据持久化）
- Web Audio API（AudioContext.decodeAudioData）
- Canvas API（波形渲染、视频导出合成）
- MediaRecorder API（音频回退提取、视频导出）
- Pointer Events（时间轴拖拽交互）
