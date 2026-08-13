#!/usr/bin/env python3
"""
FilmArchive FFmpeg Rendering Service.

True render from source files — like a video editor's export pipeline,
with real-time progress tracking.

Endpoints:
  POST /render         composite render  (multipart: videos + params)
  POST /render-single  single-video trim (raw body + X-* headers)
  GET  /progress/<id>  polling endpoint  → {progress: 0–100, status, ...}
  GET  /result/<id>    download result   → MP4 binary
  GET  /health         service status

Start:   python3 encode_server.py
Default: http://127.0.0.1:8765
"""

import http.server
import subprocess
import tempfile
import os
import sys
import json
import re
import shutil
import threading
import time
import uuid
import mimetypes

FFMPEG_HOME = os.path.expanduser('~/bin/ffmpeg')
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

# ============================================================
# helpers
# ============================================================

def _find_ffmpeg():
    if os.path.isfile(FFMPEG_HOME) and os.access(FFMPEG_HOME, os.X_OK):
        return FFMPEG_HOME
    return shutil.which('ffmpeg')


def _parse_multipart(body: bytes, content_type: str) -> dict:
    """Parse multipart/form-data → {field_name: (filename, data_bytes)}."""
    match = re.search(r'boundary=([^;\s]+)', content_type)
    if not match:
        raise ValueError('No boundary in Content-Type')
    boundary = match[1].encode()
    if boundary.startswith(b'"') and boundary.endswith(b'"'):
        boundary = boundary[1:-1]

    parts = body.split(b'--' + boundary)
    result = {}

    for part in parts[1:-1]:
        if not part or part == b'--':
            continue
        header_end = part.find(b'\r\n\r\n')
        if header_end < 0:
            continue
        headers_block = part[:header_end].decode('utf-8', errors='replace')
        data = part[header_end + 4:]
        if data.endswith(b'\r\n'):
            data = data[:-2]

        disp = re.search(
            r'Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?',
            headers_block, re.IGNORECASE)
        if not disp:
            continue
        result[disp.group(1)] = (disp.group(2) or None, data)

    return result


def _build_composite_filter(video_count, layout, video_params, resolution):
    """Build FFmpeg filter_complex for N-video grid compositing."""
    cols = layout['cols']
    rows = layout['rows']
    cell_w = resolution['w'] // cols
    cell_h = resolution['h'] // rows

    chains = []
    scaled = []

    for i in range(video_count):
        vp = video_params[i] if i < len(video_params) else {}
        start = float(vp.get('start', 0))
        duration = vp.get('duration')
        rotation = int(vp.get('rotation', 0))

        dur_part = f':duration={duration}' if duration else ''
        chain = f'[{i}:v]trim={start}{dur_part},setpts=PTS-STARTPTS'

        if rotation == 90:
            chain += ',transpose=1'
        elif rotation == 180:
            chain += ',transpose=1,transpose=1'
        elif rotation == 270:
            chain += ',transpose=2'

        chain += f',scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease'
        chain += f',pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2:black'
        chain += ',setsar=1,format=pix_fmts=yuv420p'

        label = f'v{i}'
        chain += f'[{label}]'
        chains.append(chain)
        scaled.append(label)

    # Fill remaining cells with black
    while len(scaled) < cols * rows:
        idx = len(scaled)
        label = f'v{idx}'
        chains.append(
            f'color=black:size={cell_w}x{cell_h}:rate=1,'
            f'format=pix_fmts=yuv420p,loop=-1:size=1:start=0,'
            f'trim=0:1,setpts=PTS-STARTPTS[{label}]'
        )
        scaled.append(label)

    # Stack rows then columns
    row_labels = []
    for r in range(rows):
        row_cells = scaled[r * cols:(r + 1) * cols]
        if cols == 1:
            row_labels.append(row_cells[0])
        else:
            rl = f'row{r}'
            inputs = ''.join(f'[{c}]' for c in row_cells)
            chains.append(f'{inputs}hstack=inputs={cols}:shortest=0[{rl}]')
            row_labels.append(rl)

    if rows == 1:
        out_label = row_labels[0]
    else:
        out_label = 'outv'
        inputs = ''.join(f'[{r}]' for r in row_labels)
        chains.append(f'{inputs}vstack=inputs={rows}:shortest=0[{out_label}]')

    return ';\n'.join(chains), out_label


# ============================================================
# job manager
# ============================================================

_jobs = {}          # job_id → dict
_jobs_lock = threading.Lock()

def _create_job(total_duration):
    """Create a new render job, returns job_id."""
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {
            'status': 'processing',
            'progress': 0,
            'total_duration': total_duration,
            'result_path': None,
            'error': None,
            'created_at': time.time(),
        }
    print(f'[job] CREATED {job_id} (total jobs: {len(_jobs)})', file=sys.stderr, flush=True)
    return job_id

def _update_progress(job_id, time_sec):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job['total_duration'] <= 0:
            return
        pct = min(99, max(0, (time_sec / job['total_duration']) * 100))
        job['progress'] = round(pct, 1)

def _finish_job(job_id, result_path):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
            job['status'] = 'done'
            job['progress'] = 100
            job['result_path'] = result_path
            print(f'[job] FINISHED {job_id}', file=sys.stderr, flush=True)
        else:
            print(f'[job] FINISHED {job_id} → NOT FOUND', file=sys.stderr, flush=True)

def _fail_job(job_id, error_msg):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
            job['status'] = 'error'
            job['error'] = error_msg
            print(f'[job] FAILED {job_id}: {error_msg}', file=sys.stderr, flush=True)
        else:
            print(f'[job] FAILED {job_id} → NOT FOUND: {error_msg}', file=sys.stderr, flush=True)

def _get_job(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            known = list(_jobs.keys())
            print(f'[job] GET {job_id} → NOT FOUND (known: {known})', file=sys.stderr, flush=True)
        return job

def _cleanup_old_jobs(max_age=300):
    """Remove jobs older than max_age seconds."""
    now = time.time()
    with _jobs_lock:
        stale = [jid for jid, j in _jobs.items()
                 if now - j['created_at'] > max_age]
        for jid in stale:
            job = _jobs[jid]
            if job.get('result_path') and os.path.exists(job['result_path']):
                try:
                    os.unlink(job['result_path'])
                except OSError:
                    pass
            del _jobs[jid]


# ============================================================
# FFmpeg runner (background thread)
# ============================================================

def _run_ffmpeg_render(job_id, cmd, total_duration, tmpfiles, result_path):
    """Run FFmpeg in background, parse stderr for progress, update job."""
    try:
        proc = subprocess.Popen(
            cmd,
            stderr=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            universal_newlines=True,
            bufsize=1,
        )

        time_re = re.compile(r'time=(\d+):(\d+):(\d+)\.(\d+)')

        for line in proc.stderr:
            m = time_re.search(line)
            if m:
                h, mi, s, cs = int(m[1]), int(m[2]), int(m[3]), int(m[4])
                time_sec = h * 3600 + mi * 60 + s + cs / 100.0
                _update_progress(job_id, time_sec)

        proc.wait()

        if proc.returncode == 0:
            _finish_job(job_id, result_path)
        else:
            _fail_job(job_id, f'FFmpeg exited with code {proc.returncode}')
    except Exception as e:
        _fail_job(job_id, str(e))
    finally:
        # Clean up temp input files
        for tf in tmpfiles:
            if os.path.exists(tf):
                try:
                    os.unlink(tf)
                except OSError:
                    pass


# ============================================================
# HTTP handler
# ============================================================

class RenderHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        if '/health' in str(args) or '/progress/' in str(args):
            return
        super().log_message(fmt, *args)

    # -- CORS ---------------------------------------------------

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers',
                         'Content-Type, X-Filename, X-Start, X-Duration, X-Fps, X-Rotation')

    def _reply_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _reply_file(self, path, filename_hint):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header('Content-Type', 'video/mp4')
        self.send_header('Content-Length', str(size))
        self.send_header('Content-Disposition',
                         f'attachment; filename="{filename_hint}.mp4"')
        self._cors()
        self.end_headers()
        with open(path, 'rb') as f:
            shutil.copyfileobj(f, self.wfile)

    def _reply_text(self, code, msg):
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self._cors()
        self.end_headers()
        self.wfile.write(msg.encode('utf-8'))

    # -- routes -------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def _serve_static(self, file_path, content_type=None):
        """Serve a static file from ROOT_DIR, or 404."""
        # Prevent directory traversal
        safe = os.path.normpath(os.path.join(ROOT_DIR, file_path.lstrip('/')))
        if not safe.startswith(ROOT_DIR) or not os.path.isfile(safe):
            self._reply_text(404, 'Not found')
            return

        if content_type is None:
            content_type, _ = mimetypes.guess_type(safe)
            if content_type is None:
                content_type = 'application/octet-stream'

        size = os.path.getsize(safe)
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        with open(safe, 'rb') as f:
            shutil.copyfileobj(f, self.wfile)

    def do_GET(self):
        path = self.path.split('?')[0].rstrip('/')

        # --- API routes ---
        if path == '/health':
            ffmpeg = _find_ffmpeg()
            if ffmpeg:
                try:
                    r = subprocess.run([ffmpeg, '-version'],
                                       capture_output=True, timeout=5)
                    ver = r.stdout.decode().splitlines()[0] if r.stdout else ''
                except Exception:
                    ver = 'unknown'
                self._reply_json(200, {'status': 'ok', 'ffmpeg': ver})
            else:
                self._reply_json(503, {'status': 'unavailable'})
            return

        if path == '/debug/jobs':
            with _jobs_lock:
                snapshot = {jid: {'status': j['status'], 'progress': j['progress'],
                                  'created_at': j['created_at']} for jid, j in _jobs.items()}
            self._reply_json(200, {'count': len(snapshot), 'jobs': snapshot})
            return

        if path.startswith('/progress/'):
            job_id = path.split('/')[-1]
            job = _get_job(job_id)
            if not job:
                print(f'[progress] job not found: {job_id!r} (path={self.path!r})', file=sys.stderr, flush=True)
                # Return 200 with status 'not_found' instead of 404 — client retries
                self._reply_json(200, {'progress': 0, 'status': 'not_found', 'error': None})
            else:
                self._reply_json(200, {
                    'progress': job['progress'],
                    'status': job['status'],
                    'error': job.get('error'),
                })
            return

        if path.startswith('/result/'):
            job_id = path.split('/')[-1]
            job = _get_job(job_id)
            if not job:
                self._reply_json(404, {'error': 'job not found'})
            elif job['status'] != 'done':
                self._reply_json(409, {
                    'error': 'job not finished',
                    'status': job['status'],
                    'progress': job['progress'],
                })
            else:
                result_path = job.get('result_path')
                if not result_path or not os.path.exists(result_path):
                    self._reply_json(500, {'error': 'result file missing'})
                else:
                    self._reply_file(result_path, 'export')
                    with _jobs_lock:
                        if job_id in _jobs:
                            del _jobs[job_id]
                    try:
                        os.unlink(result_path)
                    except OSError:
                        pass
            return

        # --- Static file serving ---
        if path == '' or path == '/' or path == '/index.html':
            self._serve_static('index.html', 'text/html; charset=utf-8')
        else:
            self._serve_static(path)

    def do_POST(self):
        path = self.path.rstrip('/')

        if path == '/render':
            self._handle_render()
        elif path == '/render-single':
            self._handle_render_single()
        else:
            self._reply_json(404, {'error': 'not found'})

    # ============================================================
    # /render-single
    # ============================================================

    def _handle_render_single(self):
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            self._reply_json(503, {'error': 'FFmpeg not installed'})
            return

        cl = int(self.headers.get('Content-Length', 0))
        if cl == 0:
            self._reply_json(400, {'error': 'Empty body'})
            return

        try:
            start_sec = float(self.headers.get('X-Start', '0'))
        except ValueError:
            start_sec = 0
        try:
            duration_sec = float(self.headers.get('X-Duration', '0'))
        except ValueError:
            duration_sec = 0
        try:
            fps = float(self.headers.get('X-Fps', '30'))
        except ValueError:
            fps = 30
        try:
            rotation = int(self.headers.get('X-Rotation', '0'))
        except ValueError:
            rotation = 0

        filename_hint = self.headers.get('X-Filename', 'export')
        if '.' in filename_hint:
            filename_hint = filename_hint.rsplit('.', 1)[0]

        src_data = self.rfile.read(cl)

        # Determine total duration for progress
        total_dur = duration_sec if duration_sec > 0 else 999

        # Write source to temp file
        src_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix='.src', delete=False) as f:
                f.write(src_data)
                src_path = f.name
        except Exception as e:
            self._reply_json(500, {'error': str(e)})
            return

        result_path = tempfile.mktemp(suffix='.mp4')

        # Build FFmpeg command
        cmd = [ffmpeg, '-y']
        if start_sec > 0.001:
            cmd += ['-ss', str(start_sec)]
        cmd += ['-i', src_path]
        if duration_sec > 0.001:
            cmd += ['-t', str(duration_sec)]

        vf_parts = [f'fps={fps}']
        if rotation == 90:
            vf_parts.append('transpose=1')
        elif rotation == 180:
            vf_parts.append('transpose=1,transpose=1')
        elif rotation == 270:
            vf_parts.append('transpose=2')

        cmd += [
            '-vf', ','.join(vf_parts),
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
            '-c:a', 'aac', '-b:a', '192k',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            result_path,
        ]

        job_id = _create_job(total_dur)
        print(f'[render-single] job={job_id} trim={start_sec:.1f}+{duration_sec:.1f}s '
              f'src={len(src_data)>>10} KiB')

        threading.Thread(
            target=_run_ffmpeg_render,
            args=(job_id, cmd, total_dur, [src_path], result_path),
            daemon=True,
        ).start()

        self._reply_json(200, {'job_id': job_id, 'total_duration': total_dur})

    # ============================================================
    # /render  (composite)
    # ============================================================

    def _handle_render(self):
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            self._reply_json(503, {'error': 'FFmpeg not installed'})
            return

        content_type = self.headers.get('Content-Type', '')
        if 'multipart/form-data' not in content_type:
            self._reply_json(400, {'error': 'Expected multipart/form-data'})
            return

        cl = int(self.headers.get('Content-Length', 0))
        print(f'[render] reading body: Content-Length={cl}', file=sys.stderr, flush=True)
        body = self.rfile.read(cl)
        print(f'[render] body read: {len(body)} bytes (expected {cl})', file=sys.stderr, flush=True)

        try:
            fields = _parse_multipart(body, content_type)
        except Exception as e:
            self._reply_json(400, {'error': f'Bad multipart: {e}'})
            return

        print(f'[render] parsed {len(fields)} fields: {list(fields.keys())}', file=sys.stderr, flush=True)

        params_raw = fields.get('params')
        if not params_raw:
            self._reply_json(400, {'error': 'Missing params field'})
            return
        params = json.loads(params_raw[1].decode('utf-8'))

        resolution = params.get('resolution', {'w': 1920, 'h': 1080})
        fps = params.get('fps', 30)
        layout = params.get('layout', {'cols': 1, 'rows': 1})
        video_params = params.get('videos', [])
        filename_hint = params.get('filename', 'composite')
        total_duration = float(params.get('total_duration', 0))

        # Collect video parts sorted by index
        video_fields = sorted(
            [(k, v) for k, v in fields.items() if k.startswith('video_')],
            key=lambda x: int(x[0].split('_')[1])
        )

        if not video_fields:
            self._reply_json(400, {'error': 'No video files'})
            return

        tmpfiles = []
        try:
            for name, (orig_filename, data) in video_fields:
                suffix = '.mp4'
                if orig_filename and '.' in orig_filename:
                    suffix = os.path.splitext(orig_filename)[1] or '.mp4'
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                    f.write(data)
                    tmpfiles.append(f.name)
        except Exception as e:
            for tf in tmpfiles:
                if os.path.exists(tf):
                    os.unlink(tf)
            self._reply_json(500, {'error': str(e)})
            return

        result_path = tempfile.mktemp(suffix='.mp4')

        filter_str, out_label = _build_composite_filter(
            len(tmpfiles), layout, video_params, resolution
        )

        cmd = [ffmpeg, '-y']
        for tf in tmpfiles:
            cmd += ['-i', tf]
        cmd += [
            '-filter_complex', filter_str,
            '-map', f'[{out_label}]',
            '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
            '-c:a', 'aac', '-b:a', '192k',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-r', str(fps),
            result_path,
        ]

        if total_duration <= 0:
            total_duration = 999

        job_id = _create_job(total_duration)
        total_src = sum(os.path.getsize(tf) for tf in tmpfiles)
        print(f'[render] job={job_id} {len(tmpfiles)} videos '
              f'{resolution["w"]}×{resolution["h"]}@{fps}fps '
              f'dur={total_duration:.1f}s src={total_src>>10} KiB')

        threading.Thread(
            target=_run_ffmpeg_render,
            args=(job_id, cmd, total_duration, tmpfiles, result_path),
            daemon=True,
        ).start()

        self._reply_json(200, {'job_id': job_id, 'total_duration': total_duration})


# ============================================================
# main
# ============================================================

def _start_cleanup_timer(interval=60):
    """Periodically clean up stale jobs."""
    def _cleanup_loop():
        while True:
            time.sleep(interval)
            _cleanup_old_jobs()
    t = threading.Thread(target=_cleanup_loop, daemon=True)
    t.start()


def main():
    ffmpeg = _find_ffmpeg()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    url = f'http://127.0.0.1:{port}'

    print('🎬 FilmArchive FFmpeg Rendering Service')
    print(f'   FFmpeg: {ffmpeg or "⚠️  NOT FOUND"}')
    print(f'   App:    {url}')
    print('   Press Ctrl+C to stop\n')

    server = http.server.HTTPServer(('127.0.0.1', port), RenderHandler)
    _start_cleanup_timer()

    # Auto-open browser AFTER server is bound (macOS)
    try:
        subprocess.Popen(['open', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')
        server.server_close()


if __name__ == '__main__':
    main()
