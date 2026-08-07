// =============================================
// Video Groups — Full Application Logic
// with IndexedDB persistence
// =============================================

// --- Constants ---
const PAGE_SIZE = 8;
const VIDEO_SLOTS = 8;
const COMPARE_SLOTS = 8;
const GROUP_COLORS = ['#e2b04a','#c95a4a','#5b8c5a','#6b8cbf','#b07cd8','#d4855e','#4ea5a5','#c47db5'];
let colorIdx = 0;

// --- State ---
const state = {
  groups: [],
  activeView: 'groups',
  activeGroupId: null,
  groupPage: 0,
  groupIsPlaying: false,
  compareIsPlaying: false,
  compareGroupId: null,
  // Remember where the user came from before entering compare view
  compareSourceView: 'groups',
  compareSourceGroupId: null,
  // Per-group compare slot storage — exposed via getter/setter below
  _compareByGroup: {},
  timelineVisible: false,
};

// compareSlots and compareOffsets are proxied to per-group storage
// so each group maintains independent compare selections.
function _ensureCompareGroup(gid) {
  if (!state._compareByGroup[gid]) {
    state._compareByGroup[gid] = {
      slots: new Array(COMPARE_SLOTS).fill(null),
      offsets: new Array(COMPARE_SLOTS).fill(0),
      duration: null,
      commonStart: 0,
      audioData: new Array(COMPARE_SLOTS).fill(null),
    };
  }
  return state._compareByGroup[gid];
}

Object.defineProperty(state, 'compareSlots', {
  get() {
    if (!this.compareGroupId) return new Array(COMPARE_SLOTS).fill(null);
    return _ensureCompareGroup(this.compareGroupId).slots;
  },
  set(v) {
    if (this.compareGroupId) {
      _ensureCompareGroup(this.compareGroupId).slots = v;
    }
  },
  enumerable: true,
  configurable: true,
});

Object.defineProperty(state, 'compareOffsets', {
  get() {
    if (!this.compareGroupId) return new Array(COMPARE_SLOTS).fill(0);
    return _ensureCompareGroup(this.compareGroupId).offsets;
  },
  set(v) {
    if (this.compareGroupId) {
      _ensureCompareGroup(this.compareGroupId).offsets = v;
    }
  },
  enumerable: true,
  configurable: true,
});

Object.defineProperty(state, 'compareDuration', {
  get() {
    if (!this.compareGroupId) return null;
    return _ensureCompareGroup(this.compareGroupId).duration;
  },
  set(v) {
    if (this.compareGroupId) {
      _ensureCompareGroup(this.compareGroupId).duration = v;
    }
  },
  enumerable: true,
  configurable: true,
});

// ============================================
// IndexedDB Persistence Layer
// ============================================
const DB_NAME = 'FilmArchive';
const DB_VERSION = 3;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains('groups')) {
          db.createObjectStore('groups', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('videos')) {
          db.createObjectStore('videos', { keyPath: 'id' });
        }
      }
      if (oldVersion < 2) {
        // Migrate: add parentId to existing groups
        const tx = e.target.transaction;
        const store = tx.objectStore('groups');
        store.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) {
            if (cursor.value.parentId === undefined) {
              const updated = cursor.value;
              updated.parentId = null;
              cursor.update(updated);
            }
            cursor.continue();
          }
        };
      }
      if (oldVersion < 3) {
        // v3: no schema change — just bumping version to fix downgrade issue.
        // Videos stored with opfs:true during the experiment will be skipped
        // (they never had data written successfully anyway).
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function loadAllData() {
  const db = await openDB();
  console.log('[FilmArchive] IndexedDB 已打开');

  // Load groups
  const groups = await new Promise((resolve, reject) => {
    const tx = db.transaction('groups', 'readonly');
    const store = tx.objectStore('groups');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  console.log('[FilmArchive] 从DB读取到', groups.length, '个分组');

  // Load videos
  const videos = await new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const store = tx.objectStore('videos');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  console.log('[FilmArchive] 从DB读取到', videos.length, '个视频');

  // Assemble: attach videos to their groups, create blob URLs
  const videoMap = {};
  videos.forEach(v => {
    if (v.blob) {
      v.url = URL.createObjectURL(v.blob);
      // Extract fileSize from blob for legacy records
      if (!v.fileSize) v.fileSize = v.blob.size;
      delete v.blob; // Don't keep blob in memory
    }
    if (v.renderedBlob) {
      v.renderedUrl = URL.createObjectURL(v.renderedBlob);
      delete v.renderedBlob;
    }
    // Default rotation for legacy records
    if (v.rotation === undefined) v.rotation = 0;
    // Default metadata for legacy records
    if (v.width === undefined) v.width = null;
    if (v.height === undefined) v.height = null;
    if (v.duration === undefined) v.duration = null;
    if (v.fps === undefined) v.fps = null;
    if (v.useProxy === undefined) v.useProxy = false;
    if (v.fileSize === undefined) v.fileSize = null;
    if (v.fileType === undefined) v.fileType = '';
    if (v.originalName === undefined) v.originalName = '';
    if (!videoMap[v.groupId]) videoMap[v.groupId] = [];
    videoMap[v.groupId].push(v);
  });

  groups.forEach(g => {
    // Normalize parentId for legacy records
    if (g.parentId === undefined) g.parentId = null;
    g.videos = videoMap[g.id] || [];
    // Sort by addedAt descending (newest first)
    g.videos.sort((a, b) => b.addedAt - a.addedAt);
  });

  // Fix orphaned 小组: parentId pointing to a nonexistent group → promote to 大组
  groups.forEach(g => {
    if (g.parentId && !groups.some(p => p.id === g.parentId)) {
      g.parentId = null;
    }
  });

  // Restore persisted compare state (alignment offsets + duration + audio data) for each group
  groups.forEach(g => {
    const hasState = (g.compareOffsets && Array.isArray(g.compareOffsets) && g.compareOffsets.some(o => o !== 0))
      || (g.audioData && g.audioData.some(d => d !== null))
      || (g.commonStart)
      || (g.compareDuration !== undefined && g.compareDuration !== null);
    if (hasState) {
      if (!state._compareByGroup[g.id]) {
        state._compareByGroup[g.id] = {
          slots: new Array(COMPARE_SLOTS).fill(null),
          offsets: new Array(COMPARE_SLOTS).fill(0),
          duration: null,
          commonStart: 0,
          audioData: new Array(COMPARE_SLOTS).fill(null),
        };
      }
      if (g.compareOffsets) state._compareByGroup[g.id].offsets = g.compareOffsets;
      if (g.compareDuration !== undefined && g.compareDuration !== null) {
        state._compareByGroup[g.id].duration = g.compareDuration;
      }
      if (g.commonStart !== undefined) {
        state._compareByGroup[g.id].commonStart = g.commonStart;
      }
      // Restore audio envelope data (convert plain arrays back to Float32Array)
      if (g.audioData && Array.isArray(g.audioData)) {
        state._compareByGroup[g.id].audioData = g.audioData.map(d => d ? {
          ...d,
          energyEnvelope: new Float32Array(d.energyEnvelope),
        } : null);
      }
    }
    // Don't keep compare state duplicated on the group object
    delete g.compareOffsets;
    delete g.compareDuration;
    delete g.commonStart;
    delete g.audioData;
  });

  state.groups = groups;
  // Track color index to avoid duplicates
  if (groups.length > 0) {
    const lastColor = groups[groups.length - 1].color;
    const idx = GROUP_COLORS.indexOf(lastColor);
    colorIdx = idx >= 0 ? idx + 1 : groups.length;
  }
}

async function persistGroup(group) {
  const db = await openDB();
  const tx = db.transaction('groups', 'readwrite');
  const store = tx.objectStore('groups');
  // Read existing record first to preserve compare state (alignment offsets)
  const existing = await new Promise((resolve) => {
    const req = store.get(group.id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  const record = {
    id: group.id,
    name: group.name,
    description: group.description,
    color: group.color,
    parentId: group.parentId || null,
  };
  // Preserve previously saved compare state when updating group metadata
  if (existing) {
    if (existing.compareOffsets) record.compareOffsets = existing.compareOffsets;
    if (existing.compareDuration !== undefined && existing.compareDuration !== null) {
      record.compareDuration = existing.compareDuration;
    }
    if (existing.commonStart !== undefined) record.commonStart = existing.commonStart;
    if (existing.audioData) record.audioData = existing.audioData;
  }
  store.put(record);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteGroupFromDB(groupId) {
  const db = await openDB();
  const tx = db.transaction('groups', 'readwrite');
  tx.objectStore('groups').delete(groupId);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Recursively delete a group and ALL its descendants:
 * - Child groups (recursive)
 * - Videos (blob URLs revoked + DB rows removed)
 * - Compare state cleaned up
 */
async function deleteGroupCascade(groupId) {
  const group = findGroup(groupId);
  if (!group) return;

  // 1. Recursively delete all child groups first
  const children = getChildGroups(groupId);
  for (const child of children) {
    await deleteGroupCascade(child.id);
  }

  // 2. Clean up all videos in this group
  for (const video of group.videos) {
    if (video.url) URL.revokeObjectURL(video.url);
    if (video.renderedUrl) URL.revokeObjectURL(video.renderedUrl);
    await deleteVideoFromDB(video.id);
  }

  // 3. Remove from state and compare storage
  state.groups = state.groups.filter(g => g.id !== groupId);
  delete state._compareByGroup[groupId];

  // 4. Delete group from IndexedDB
  await deleteGroupFromDB(groupId);
}

async function persistVideo(videoItem, blob) {
  const db = await openDB();
  const tx = db.transaction('videos', 'readwrite');
  const store = tx.objectStore('videos');
  store.put({
    id: videoItem.id,
    groupId: videoItem.groupId,
    title: videoItem.title,
    description: videoItem.description,
    addedAt: videoItem.addedAt,
    rotation: videoItem.rotation || 0,
    width: videoItem.width || null,
    height: videoItem.height || null,
    duration: videoItem.duration || null,
    fps: videoItem.fps || null,
    useProxy: videoItem.useProxy || false,
    fileSize: videoItem.fileSize || null,
    fileType: videoItem.fileType || '',
    originalName: videoItem.originalName || '',
    blob: blob,
  });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteVideoFromDB(videoId) {
  const db = await openDB();
  const tx = db.transaction('videos', 'readwrite');
  tx.objectStore('videos').delete(videoId);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function persistRenderedVideo(videoId, renderedBlob) {
  const db = await openDB();
  const tx = db.transaction('videos', 'readwrite');
  const store = tx.objectStore('videos');
  const getReq = store.get(videoId);
  return new Promise((resolve, reject) => {
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) { resolve(); return; }
      record.renderedBlob = renderedBlob;
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

async function updateVideoMeta(videoId, updates) {
  const db = await openDB();
  const tx = db.transaction('videos', 'readwrite');
  const store = tx.objectStore('videos');
  const getReq = store.get(videoId);
  return new Promise((resolve, reject) => {
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) { resolve(); return; }
      Object.assign(record, updates);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// --- DOM Refs ---
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const nav = $('#nav');
const navBack = $('#navBack');
const navBreadcrumb = $('#navBreadcrumb');
const navCompareBtn = $('#navCompare');

const viewGroups = $('#viewGroups');
const viewGroup = $('#viewGroup');
const viewCompare = $('#viewCompare');

// Sub-groups within group detail
const subGroupsSection = $('#subGroupsSection');
const subGroupsGrid = $('#subGroupsGrid');
const btnNewSubGroup = $('#btnNewSubGroup');

// Upload form elements (in group detail)
const groupAddVideo = $('#groupAddVideo');
const btnAddVideo = $('#btnAddVideo');
const videoForm = $('#videoForm');
const videoTitle = $('#videoTitle');
const videoDesc = $('#videoDescription');
const videoFile = $('#videoFile');
const fileDropZone = $('#fileDropZone');
const filePreview = $('#filePreview');
const fileName = $('#fileName');
const fileSize = $('#fileSize');
const fileClearBtn = $('#fileClear');

// Groups view
const btnNewGroup = $('#btnNewGroup');

const groupsGrid = $('#groupsGrid');
const groupsEmpty = $('#groupsEmpty');
const groupsCount = $('#groupsCount');

const groupDetailName = $('#groupDetailName');
const groupDetailDesc = $('#groupDetailDesc');
const groupDetailMeta = $('#groupDetailMeta');
const groupGallery = $('#groupGallery');
const groupEmpty = $('#groupEmpty');
const groupMasterControl = $('#groupMasterControl');
const groupMasterPlayBtn = $('#groupMasterPlayBtn');
const groupMasterBtnLabel = $('#groupMasterBtnLabel');
const groupPagination = $('#groupPagination');
const groupPrevPage = $('#groupPrevPage');
const groupNextPage = $('#groupNextPage');
const groupPageIndicator = $('#groupPageIndicator');
const groupActions = $('#groupActions');

const compareChips = $('#compareChips');
const compareGroupTree = $('#compareGroupTree');
const compareSlotsEl = $('#compareSlots');
const compareMasterControl = $('#compareMasterControl');
const btnFullscreen = $('#btnFullscreen');
const btnAlignAudio = $('#btnAlignAudio');
const btnRenderAll = $('#btnRenderAll');
const btnTimelineToggle = $('#btnTimelineToggle');
const compareMasterPlayBtn = $('#compareMasterPlayBtn');
const compareMasterBtnLabel = $('#compareMasterBtnLabel');

// Timeline panel elements
const timelinePanel = $('#timelinePanel');
const timelineTracks = $('#timelineTracks');
const timelineRuler = $('#timelineRuler');
const timelineScroll = $('#timelineScroll');
const timelineRangeBar = $('#timelineRangeBar');
const timelineRangeSelection = $('#timelineRangeSelection');
const timelineCursor = $('#timelineCursor');
const timelineZoomLabel = $('#timelineZoomLabel');

const toast = $('#toast');
const container = $('.container');

// Zoom
const navZoom = $('#navZoom');
const btnZoomIn = $('#btnZoomIn');
const btnZoomOut = $('#btnZoomOut');
const btnZoomReset = $('#btnZoomReset');
const zoomLabel = $('#zoomLabel');

const modalOverlay = $('#modalOverlay');
const modal = $('#modal');
const modalTitle = $('#modalTitle');
const modalLabel1 = $('#modalLabel1');
const modalInput1 = $('#modalInput1');
const modalField2 = $('#modalField2');
const modalLabel2 = $('#modalLabel2');
const modalInput2 = $('#modalInput2');
const modalCancel = $('#modalCancel');
const modalConfirm = $('#modalConfirm');
const modalMessage = $('#modalMessage');
const modalField1 = $('#modalField1');

const cardVideoMap = new WeakMap();
let modalCallback = null;

// --- Toast ---
let toastTimer = null;

// --- Zoom ---
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
let zoomLevel = 1;

function applyZoom(level) {
  zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
  zoomLevel = Math.round(zoomLevel * 100) / 100; // round to 2 decimal places
  container.style.setProperty('--zoom', zoomLevel);
  zoomLabel.textContent = Math.round(zoomLevel * 100) + '%';
}

function zoomIn() { applyZoom(zoomLevel + ZOOM_STEP); }
function zoomOut() { applyZoom(zoomLevel - ZOOM_STEP); }
function zoomReset() { applyZoom(1); }

btnZoomIn.addEventListener('click', zoomIn);
btnZoomOut.addEventListener('click', zoomOut);
btnZoomReset.addEventListener('click', zoomReset);

// Keyboard shortcuts for zoom
document.addEventListener('keydown', (e) => {
  // Ctrl+= or Ctrl+Shift+= (which is Ctrl++)
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    zoomIn();
  }
  // Ctrl+-
  if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    e.preventDefault();
    zoomOut();
  }
  // Ctrl+0
  if ((e.ctrlKey || e.metaKey) && e.key === '0') {
    e.preventDefault();
    zoomReset();
  }
});

function showToast(msg, type) {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = 'toast';
  void toast.offsetWidth;
  toast.classList.add('toast--visible');
  if (type) toast.classList.add(`toast--${type}`);
  toastTimer = setTimeout(() => { toast.classList.remove('toast--visible'); toastTimer = null; }, 2800);
}

// --- Helpers ---
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function totalGroupPages(group) {
  return Math.max(1, Math.ceil(group.videos.length / PAGE_SIZE));
}

function getGroupPageVideos(group) {
  const start = state.groupPage * PAGE_SIZE;
  return group.videos.slice(start, start + PAGE_SIZE);
}

function findGroup(id) { return state.groups.find(g => g.id === id); }
function findVideo(id) {
  for (const g of state.groups) {
    const v = g.videos.find(v => v.id === id);
    if (v) return { group: g, video: v };
  }
  return null;
}

async function moveVideoToGroup(videoId, targetGroupId) {
  const result = findVideo(videoId);
  if (!result) return false;
  const { group: sourceGroup, video } = result;
  if (sourceGroup.id === targetGroupId) return false; // same group, no-op

  const targetGroup = findGroup(targetGroupId);
  if (!targetGroup) return false;

  // Remove from source group
  sourceGroup.videos = sourceGroup.videos.filter(v => v.id !== videoId);
  // Add to target group
  video.groupId = targetGroupId;
  targetGroup.videos.unshift(video);
  // Persist
  await updateVideoMeta(videoId, { groupId: targetGroupId });
  return true;
}

function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// --- Hierarchy helpers ---
function isParentGroup(group) { return !group.parentId; }
function getChildGroups(parentId) { return state.groups.filter(g => g.parentId === parentId); }
function getParentGroup(child) { return child && child.parentId ? findGroup(child.parentId) : null; }

function getGroupVideoCount(group) {
  if (!group) return 0;
  let count = group.videos.length;
  for (const child of getChildGroups(group.id)) {
    count += getGroupVideoCount(child);
  }
  return count;
}

function getGroupAllVideos(group) {
  if (!group) return [];
  let videos = [...group.videos];
  for (const child of getChildGroups(group.id)) {
    videos = videos.concat(getGroupAllVideos(child));
  }
  return videos;
}

function getSubGroupCount(group) {
  if (!group) return 0;
  let count = getChildGroups(group.id).length;
  for (const child of getChildGroups(group.id)) {
    count += getSubGroupCount(child);
  }
  return count;
}

function getGroupBreadcrumb(groupId) {
  const crumbs = [];
  let current = findGroup(groupId);
  while (current) {
    crumbs.unshift({ name: current.name, id: current.id });
    current = getParentGroup(current);
  }
  return crumbs;
}

function getGroupCoverUrl(group) {
  if (!group) return null;
  // Check own videos first
  if (group.videos.length > 0 && group.videos[0].url) return group.videos[0].url;
  // Then check descendants
  for (const child of getChildGroups(group.id)) {
    const url = getGroupCoverUrl(child);
    if (url) return url;
  }
  return null;
}

// Check if childId is a descendant of ancestorId (prevents circular nesting)
function isDescendantOf(ancestorId, childId) {
  if (ancestorId === childId) return true;
  const children = getChildGroups(ancestorId);
  for (const child of children) {
    if (isDescendantOf(child.id, childId)) return true;
  }
  return false;
}

// Move a group to a new parent (with circular check)
async function moveGroupToParent(groupId, newParentId) {
  if (groupId === newParentId) return false;
  if (isDescendantOf(groupId, newParentId)) {
    showToast('不能将分组移到它自己的子分组中', 'error');
    return false;
  }
  const group = findGroup(groupId);
  if (!group) return false;
  group.parentId = newParentId;
  await persistGroup(group);
  return true;
}

// --- Modal ---
function showModal(title, label1, value1, onConfirm, opts = {}) {
  // Reset to form mode
  modalMessage.style.display = 'none';
  modalField1.style.display = 'block';
  modalConfirm.classList.remove('modal__confirm--danger');
  modalConfirm.textContent = '确认';

  modalTitle.textContent = title;
  modalLabel1.textContent = label1;
  modalInput1.value = value1 || '';
  modalInput1.focus();

  if (opts.field2Label) {
    modalField2.style.display = 'block';
    modalLabel2.textContent = opts.field2Label;
    modalInput2.value = opts.field2Value || '';
  } else {
    modalField2.style.display = 'none';
    modalInput2.value = '';
  }

  modalCallback = () => onConfirm(modalInput1.value.trim(), modalInput2.value.trim());
  modalOverlay.style.display = 'flex';
}

function showConfirmDialog(title, message, onConfirm) {
  // Switch to confirm mode: hide inputs, show message, red button
  modalField1.style.display = 'none';
  modalField2.style.display = 'none';
  modalMessage.textContent = message;
  modalMessage.style.display = 'block';
  modalConfirm.classList.add('modal__confirm--danger');
  modalConfirm.textContent = '删除';

  modalTitle.textContent = title;
  modalCallback = onConfirm;
  modalOverlay.style.display = 'flex';
}

function hideModal() {
  modalOverlay.style.display = 'none';
  modalCallback = null;
}

modalCancel.addEventListener('click', hideModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) hideModal(); });
modalConfirm.addEventListener('click', () => {
  if (modalCallback) modalCallback();
  hideModal();
});

// --- Navigation ---
function navigate(view, groupId) {
  pauseAllInView();
  // Exit fullscreen if navigating away from compare
  if (viewCompare.classList.contains('compare--fullscreen')) {
    exitCompareFullscreen();
  }
  // Hide timeline panel when leaving compare view
  if (view !== 'compare') {
    state.timelineVisible = false;
    stopTimelinePlaybackCursor();
  }

  // Remember the group and view we're coming from before switching views
  const previousGroupId = state.activeGroupId;
  const previousView = state.activeView;

  state.activeView = view;
  state.activeGroupId = groupId || null;
  state.groupPage = 0;
  state.groupIsPlaying = false;

  viewGroups.style.display = view === 'groups' ? 'block' : 'none';
  viewGroup.style.display = view === 'group' ? 'block' : 'none';
  viewCompare.style.display = view === 'compare' ? 'block' : 'none';
  groupAddVideo.style.display = view === 'group' ? 'block' : 'none';

  navBack.style.display = view === 'groups' ? 'none' : 'inline-flex';
  navCompareBtn.classList.toggle('nav__action-btn--active', view === 'compare');

  if (view === 'groups') {
    navBreadcrumb.textContent = '分组';
    renderGroupsView();
  } else if (view === 'group' && groupId) {
    const crumbs = getGroupBreadcrumb(groupId);
    navBreadcrumb.textContent = crumbs.length > 1
      ? crumbs.map(c => c.name).join(' > ')
      : (crumbs.length === 1 ? crumbs[0].name : '分组详情');
    renderGroupDetail();
  } else if (view === 'compare') {
    navBreadcrumb.textContent = '对比视图';
    // Remember where we came from so the back button can return to it
    state.compareSourceView = previousView;
    state.compareSourceGroupId = previousGroupId;
    // When coming from a group page, switch to that group's videos
    if (previousGroupId && findGroup(previousGroupId)) {
      state.compareGroupId = previousGroupId;
    } else if (!state.compareGroupId || !findGroup(state.compareGroupId)) {
      state.compareGroupId = state.groups.length > 0 ? state.groups[0].id : null;
    }
    renderCompareView();
  }
}

navBack.addEventListener('click', () => {
  if (state.activeView === 'compare') {
    // Go back to the page the user came from
    if (state.compareSourceView === 'group' && state.compareSourceGroupId && findGroup(state.compareSourceGroupId)) {
      navigate('group', state.compareSourceGroupId);
    } else {
      navigate('groups');
    }
    return;
  }
  if (state.activeView === 'group') {
    const group = findGroup(state.activeGroupId);
    if (group && group.parentId) {
      // Navigate to parent group
      navigate('group', group.parentId);
      return;
    }
  }
  navigate('groups');
});
navCompareBtn.addEventListener('click', () => {
  navigate(state.activeView === 'compare' ? 'groups' : 'compare');
});
// New group button (groups view)
btnNewGroup.addEventListener('click', () => {
  showModal('新建分组', '分组名称', '', async (name) => {
    if (!name) { showToast('请输入分组名称', 'error'); return; }
    const group = {
      id: generateId(),
      name,
      description: '',
      color: GROUP_COLORS[colorIdx % GROUP_COLORS.length],
      videos: [],
    };
    colorIdx++;
    state.groups.push(group);
    await persistGroup(group);
    renderGroupsView();
    showToast(`分组「${name}」已创建`);
  });
});

// Toggle add-video form in group detail
btnAddVideo.addEventListener('click', () => {
  const form = videoForm;
  const isOpen = form.classList.contains('form--expanded');
  if (isOpen) {
    form.classList.remove('form--expanded');
    form.classList.add('form--collapsed');
    btnAddVideo.style.display = 'flex';
  } else {
    form.classList.remove('form--collapsed');
    form.classList.add('form--expanded');
    btnAddVideo.style.display = 'none';
    videoTitle.focus();
  }
});

// --- Update global stats ---
function updateGlobalStats() {
  const rootCount = state.groups.filter(g => isParentGroup(g)).length;
  const totalVideos = state.groups.reduce((s, g) => s + g.videos.length, 0);
  groupsCount.textContent = `${rootCount} 个分组 · ${totalVideos} 个视频`;
}

// ============================================
// Groups View (Home)
// ============================================
function renderGroupsView() {
  groupsGrid.innerHTML = '';

  const rootGroups = state.groups.filter(g => isParentGroup(g));

  if (rootGroups.length === 0) {
    groupsEmpty.style.display = 'flex';
    groupsCount.textContent = '0 个大组';
  } else {
    groupsEmpty.style.display = 'none';
    const subCount = state.groups.filter(g => !isParentGroup(g)).length;
    const totalVideos = state.groups.reduce((s, g) => s + g.videos.length, 0);
    groupsCount.textContent = `${rootGroups.length} 个分组 · ${totalVideos} 个视频`;
    rootGroups.forEach((group, i) => {
      const card = createGroupCard(group, i);
      groupsGrid.appendChild(card);
    });
  }
  updateGlobalStats();
}

// Drop zone on home page grid: move a group to root level
groupsGrid.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
groupsGrid.addEventListener('drop', async (e) => {
  e.preventDefault();
  // Only handle drops directly on the grid (not on child cards)
  if (e.target !== groupsGrid) return;
  const draggedId = e.dataTransfer.getData('text/plain');
  if (!draggedId) return;
  const group = findGroup(draggedId);
  if (group && group.parentId !== null) {
    group.parentId = null;
    await persistGroup(group);
    showToast('已移至顶层');
    renderGroupsView();
  }
});

function createGroupCard(group, index) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.style.animationDelay = `${index * 0.06}s`;

  const coverUrl = getGroupCoverUrl(group);
  const totalVideos = getGroupVideoCount(group);
  const subCount = getSubGroupCount(group);

  // Stack layers — up to 5 based on video count (like stacked video thumbnails)
  const stackCount = totalVideos > 1 ? Math.min(totalVideos, 5) : 0;
  if (stackCount >= 2) {
    card.setAttribute('data-stack', String(stackCount));
    // Each ghost layer: progressively larger offset + darker background for depth
    const layerDefs = [
      { x: 4,  y: 9,  r: -1.2, bg: '#141414' },
      { x: -3, y: 17, r: 0.9,  bg: '#121212' },
      { x: 5,  y: 25, r: -1.5, bg: '#101010' },
      { x: -4, y: 33, r: 1.1,  bg: '#0e0e0e' },
    ];
    for (let i = 0; i < stackCount - 1; i++) {
      const layer = document.createElement('div');
      layer.className = 'group-card__stack-layer';
      const def = layerDefs[i];
      layer.style.transform = `translate(${def.x}px, ${def.y}px) rotate(${def.r}deg)`;
      layer.style.background = def.bg;
      layer.style.zIndex = -(i + 1);
      card.insertBefore(layer, card.firstChild);
    }
  }

  // --- Cover area ---
  const cover = document.createElement('div');
  cover.className = 'group-card__cover';

  if (coverUrl) {
    const video = document.createElement('video');
    video.src = coverUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.className = 'group-card__cover-video';

    // Seek to a frame once metadata is loaded
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = 1;
    }, { once: true });

    cover.appendChild(video);

    // Play icon overlay (appears on hover)
    const icon = document.createElement('div');
    icon.className = 'group-card__cover-icon';
    icon.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><polygon points="10,8 10,16 16,12" fill="currentColor" stroke="none"/></svg>`;
    cover.appendChild(icon);

    // Stack count badge (shows total video count when multiple)
    if (totalVideos > 1) {
      const badge = document.createElement('span');
      badge.className = 'group-card__stack-badge';
      badge.textContent = `+${totalVideos - 1}`;
      card.appendChild(badge);
    }
  } else {
    // Empty cover placeholder
    cover.classList.add('group-card__cover--empty');
    cover.innerHTML = `<div class="group-card__cover-placeholder">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.7" opacity="0.25">
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <polygon points="10,8 10,16 16,12"/>
      </svg>
    </div>`;
  }

  card.appendChild(cover);

  // --- Body ---
  const body = document.createElement('div');
  body.className = 'group-card__body';

  const color = group.color || GROUP_COLORS[index % GROUP_COLORS.length];

  body.innerHTML = `
    <div class="group-card__accent" style="background:${color};"></div>
    <h3 class="group-card__name">${escapeHtml(group.name)}</h3>
    <p class="group-card__desc">${escapeHtml(group.description || '暂无描述')}</p>
    <span class="group-card__count">${subCount > 0 ? subCount + ' 个子组 · ' : ''}${totalVideos} 个视频</span>`;

  card.appendChild(body);

  // --- Click: navigate into group (with delay on name for dblclick detection) ---
  let clickTimer = null;
  const nameEl = body.querySelector('.group-card__name');

  card.addEventListener('click', (e) => {
    if (card._editing) return;
    if (nameEl && (e.target === nameEl || nameEl.contains(e.target))) {
      // Click on name — small delay to allow double-click for rename
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (!card._editing) navigate('group', group.id);
      }, 280);
    } else {
      // Click on cover or elsewhere — navigate immediately
      navigate('group', group.id);
    }
  });

  // --- Double-click group name to rename ---
  makeEditable(nameEl, {
    type: 'input',
    cssClass: 'inline-edit--card-name',
    onSave: async (v) => {
      group.name = v;
      await persistGroup(group);
      showToast('分组已重命名');
    }
  });
  // Track editing state on the card to suppress navigation during edit
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    card._editing = true;
    setTimeout(() => { card._editing = false; }, 500);
  });

  // --- Drag to nest (for reordering / moving between groups) ---
  card.draggable = true;
  card.dataset.groupId = group.id;
  card.addEventListener('dragstart', (e) => {
    if (card._editing) { e.preventDefault(); return; }
    card.classList.add('is-dragging');
    e.dataTransfer.setData('text/plain', group.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('is-dragging');
  });
  // Drop target
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => { card.classList.remove('drag-over'); });
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove('drag-over');
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === group.id) return;
    if (await moveGroupToParent(draggedId, group.id)) {
      showToast('已移入此分组');
      renderGroupsView();
    }
  });

  // --- Delete button ---
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'group-card__delete-btn';
  deleteBtn.title = '删除分组';
  deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (card._editing) return;
    const totalVideos = getGroupVideoCount(group);
    const subCount = getSubGroupCount(group);
    let msg = `确定要删除分组「${group.name}」吗？`;
    if (totalVideos > 0 || subCount > 0) {
      const parts = [];
      if (totalVideos > 0) parts.push(`${totalVideos} 个视频`);
      if (subCount > 0) parts.push(`${subCount} 个子分组`);
      msg += `\n将同时删除其中的 ${parts.join(' 和 ')}。`;
    }
    msg += `\n此操作不可撤销。`;
    showConfirmDialog('确认删除', msg, async () => {
      await deleteGroupCascade(group.id);
      showToast(`「${group.name}」已删除`);
      if (state.activeGroupId === group.id) {
        navigate('groups');
      } else {
        renderGroupsView();
      }
    });
  });
  card.appendChild(deleteBtn);

  return card;
}

// ============================================
// Group Detail View
// ============================================
function renderGroupDetail() {
  const group = findGroup(state.activeGroupId);
  if (!group) { navigate('groups'); return; }

  // --- Header ---
  groupDetailName.textContent = group.name;
  groupDetailDesc.textContent = group.description || '暂无描述';

  const children = getChildGroups(group.id);
  const totalDescendantVideos = getGroupVideoCount(group);
  const parent = getParentGroup(group);
  let metaText = `共 ${group.videos.length} 个视频`;
  if (totalDescendantVideos !== group.videos.length) {
    metaText += `（含子分组共 ${totalDescendantVideos} 个）`;
  }
  if (parent) metaText += ` · 属于「${parent.name}」`;
  groupDetailMeta.textContent = metaText;

  // --- Sub-groups section ---
  subGroupsGrid.innerHTML = '';
  subGroupsSection.style.display = 'block'; // Always show for "new sub-group" button
  if (children.length > 0) {
    children.forEach((child, i) => {
      const card = createSubGroupCard(child, i);
      subGroupsGrid.appendChild(card);
    });
  }
  // Drop zone: dropping on the sub-groups grid moves into current group
  subGroupsGrid.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  subGroupsGrid.addEventListener('drop', async (e) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === group.id) return;
    if (await moveGroupToParent(draggedId, group.id)) {
      showToast('已移入此分组');
      renderGroupDetail();
    }
  });

  // --- Own videos ---
  const hasVideos = group.videos.length > 0;
  groupEmpty.style.display = hasVideos ? 'none' : 'flex';
  groupActions.style.display = 'flex';

  const pages = totalGroupPages(group);
  groupPagination.style.display = group.videos.length > PAGE_SIZE ? 'flex' : 'none';
  groupPageIndicator.textContent = `${state.groupPage + 1} / ${pages}`;
  groupPrevPage.disabled = state.groupPage === 0;
  groupNextPage.disabled = state.groupPage >= pages - 1;

  groupMasterControl.style.display = hasVideos ? 'block' : 'none';
  groupMasterPlayBtn.classList.remove('is-playing');
  groupMasterBtnLabel.textContent = '全部播放';
  state.groupIsPlaying = false;

  // Reset add-video form to collapsed state
  videoForm.classList.remove('form--expanded');
  videoForm.classList.add('form--collapsed');
  btnAddVideo.style.display = 'flex';

  renderGroupGallery(group);
}

function renderGroupGallery(group) {
  groupGallery.innerHTML = '';
  const pageVideos = getGroupPageVideos(group);

  pageVideos.forEach((video, i) => {
    const card = createVideoCard(video, i);
    groupGallery.appendChild(card);
  });

  const slotsNeeded = VIDEO_SLOTS - pageVideos.length;
  for (let i = 0; i < slotsNeeded; i++) {
    const placeholder = document.createElement('div');
    placeholder.className = 'video-card video-card--empty';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.innerHTML = `
      <div class="video-card__player" style="background:rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.12">
          <rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10,8 10,16 16,12"/>
        </svg>
      </div>
      <div class="video-card__body">
        <div class="video-card__title" style="color:#555;opacity:0.4;">空位</div>
        <div class="video-card__desc" style="color:#555;opacity:0.25;">空位</div>
      </div>`;
    groupGallery.appendChild(placeholder);
  }
}

// Sub-group card (shown inside a parent group's detail page)
function createSubGroupCard(group, index) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.style.animationDelay = `${index * 0.06}s`;
  card.dataset.groupId = group.id;

  const coverUrl = getGroupCoverUrl(group);
  const totalVideos = getGroupVideoCount(group);
  const subCount = getSubGroupCount(group);
  const color = group.color || GROUP_COLORS[index % GROUP_COLORS.length];

  // Stack layers — up to 5 based on video count (like stacked video thumbnails)
  const stackCount = totalVideos > 1 ? Math.min(totalVideos, 5) : 0;
  if (stackCount >= 2) {
    card.setAttribute('data-stack', String(stackCount));
    // Each ghost layer: progressively larger offset + darker background for depth
    const layerDefs = [
      { x: 4,  y: 9,  r: -1.2, bg: '#141414' },
      { x: -3, y: 17, r: 0.9,  bg: '#121212' },
      { x: 5,  y: 25, r: -1.5, bg: '#101010' },
      { x: -4, y: 33, r: 1.1,  bg: '#0e0e0e' },
    ];
    for (let i = 0; i < stackCount - 1; i++) {
      const layer = document.createElement('div');
      layer.className = 'group-card__stack-layer';
      const def = layerDefs[i];
      layer.style.transform = `translate(${def.x}px, ${def.y}px) rotate(${def.r}deg)`;
      layer.style.background = def.bg;
      layer.style.zIndex = -(i + 1);
      card.insertBefore(layer, card.firstChild);
    }
  }

  // Cover
  const cover = document.createElement('div');
  cover.className = 'group-card__cover';
  if (coverUrl) {
    const video = document.createElement('video');
    video.src = coverUrl;
    video.muted = true; video.playsInline = true; video.preload = 'metadata';
    video.className = 'group-card__cover-video';
    video.addEventListener('loadedmetadata', () => { video.currentTime = 1; }, { once: true });
    cover.appendChild(video);
    const icon = document.createElement('div');
    icon.className = 'group-card__cover-icon';
    icon.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><polygon points="10,8 10,16 16,12" fill="currentColor" stroke="none"/></svg>`;
    cover.appendChild(icon);
    if (totalVideos > 1) {
      const badge = document.createElement('span');
      badge.className = 'group-card__stack-badge';
      badge.textContent = `+${totalVideos - 1}`;
      card.appendChild(badge);
    }
  } else {
    cover.classList.add('group-card__cover--empty');
    cover.innerHTML = `<div class="group-card__cover-placeholder">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.7" opacity="0.25">
        <rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10,8 10,16 16,12"/>
      </svg></div>`;
  }
  card.appendChild(cover);

  // Body
  const body = document.createElement('div');
  body.className = 'group-card__body';
  body.innerHTML = `
    <div class="group-card__accent" style="background:${color};"></div>
    <h3 class="group-card__name">${escapeHtml(group.name)}</h3>
    <p class="group-card__desc">${escapeHtml(group.description || '暂无描述')}</p>
    <span class="group-card__count">${subCount > 0 ? subCount + ' 个子组 · ' : ''}${totalVideos} 个视频</span>`;
  card.appendChild(body);

  // Click → navigate into group
  let clickTimer = null;
  const nameEl = body.querySelector('.group-card__name');
  card.addEventListener('click', (e) => {
    if (card._editing || card._dragging) return;
    if (nameEl && (e.target === nameEl || nameEl.contains(e.target))) {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (!card._editing) navigate('group', group.id);
      }, 280);
    } else {
      navigate('group', group.id);
    }
  });

  // Double-click rename
  makeEditable(nameEl, {
    type: 'input',
    cssClass: 'inline-edit--card-name',
    onSave: async (v) => {
      group.name = v;
      await persistGroup(group);
      showToast('分组已重命名');
    }
  });

  // --- Drag to nest ---
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    if (card._editing) { e.preventDefault(); return; }
    card._dragging = true;
    card.classList.add('is-dragging');
    e.dataTransfer.setData('text/plain', group.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card._dragging = false;
    card.classList.remove('is-dragging');
  });

  // Drop target: allow dropping a group card (nest) or a video card (move) onto this sub-group
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('drag-over');
  });
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove('drag-over');
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;

    // Video drag: raw format is "video:<videoId>"
    if (raw.startsWith('video:')) {
      const videoId = raw.slice(6);
      const vidResult = findVideo(videoId);
      if (!vidResult) return;
      if (vidResult.group.id === group.id) return; // already in this sub-group
      if (await moveVideoToGroup(videoId, group.id)) {
        showToast('视频已移入子分组');
        renderGroupDetail();
      }
      return;
    }

    // Group drag: raw is just the group ID
    if (raw === group.id) return;
    if (await moveGroupToParent(raw, group.id)) {
      showToast('已移入此分组');
      renderGroupDetail();
    }
  });

  // --- Delete button ---
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'group-card__delete-btn';
  deleteBtn.title = '删除分组';
  deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (card._editing || card._dragging) return;
    const totalVideos = getGroupVideoCount(group);
    const subCount = getSubGroupCount(group);
    let msg = `确定要删除子分组「${group.name}」吗？`;
    if (totalVideos > 0 || subCount > 0) {
      const parts = [];
      if (totalVideos > 0) parts.push(`${totalVideos} 个视频`);
      if (subCount > 0) parts.push(`${subCount} 个子分组`);
      msg += `\n将同时删除其中的 ${parts.join(' 和 ')}。`;
    }
    msg += `\n此操作不可撤销。`;
    showConfirmDialog('确认删除', msg, async () => {
      await deleteGroupCascade(group.id);
      showToast(`「${group.name}」已删除`);
      if (state.activeGroupId === group.id) {
        navigate('groups');
      } else {
        renderGroupDetail();
      }
    });
  });
  card.appendChild(deleteBtn);

  return card;
}

// --- Group Pagination ---
groupPrevPage.addEventListener('click', () => {
  if (state.groupPage > 0) { state.groupPage--; pauseAllInView(); renderGroupDetail(); }
});
groupNextPage.addEventListener('click', () => {
  const group = findGroup(state.activeGroupId);
  if (group && state.groupPage < totalGroupPages(group) - 1) {
    state.groupPage++; pauseAllInView(); renderGroupDetail();
  }
});

// --- Group Master Play ---
groupMasterPlayBtn.addEventListener('click', () => {
  if (state.groupIsPlaying) {
    pauseCards(groupGallery);
  } else {
    playCards(groupGallery);
  }
});

// --- Group Actions ---
$('#deleteGroupBtn').addEventListener('click', async () => {
  const group = findGroup(state.activeGroupId);
  if (!group) return;
  const totalVideos = getGroupVideoCount(group);
  const subCount = getSubGroupCount(group);
  let msg = `确定要删除分组「${group.name}」吗？`;
  if (totalVideos > 0 || subCount > 0) {
    const parts = [];
    if (totalVideos > 0) parts.push(`${totalVideos} 个视频`);
    if (subCount > 0) parts.push(`${subCount} 个子分组`);
    msg += `\n将同时删除其中的 ${parts.join(' 和 ')}。`;
  }
  msg += `\n此操作不可撤销。`;
  showConfirmDialog('确认删除', msg, async () => {
    await deleteGroupCascade(group.id);
    showToast(`「${group.name}」已删除`);
    navigate('groups');
  });
});

$('#renameGroupBtn').addEventListener('click', async () => {
  const group = findGroup(state.activeGroupId);
  if (!group) return;
  showModal('重命名分组', '分组名称', group.name, async (name) => {
    if (!name) { showToast('名称不能为空', 'error'); return; }
    group.name = name;
    await persistGroup(group);
    renderGroupDetail();
    showToast('分组已重命名');
  });
});

btnNewSubGroup.addEventListener('click', () => {
  const parent = findGroup(state.activeGroupId);
  if (!parent) return;
  showModal('新建子分组', '子分组名称', '', async (name) => {
    if (!name) { showToast('请输入名称', 'error'); return; }
    const subGroup = {
      id: generateId(),
      name,
      description: '',
      color: GROUP_COLORS[colorIdx % GROUP_COLORS.length],
      videos: [],
      parentId: parent.id,
    };
    colorIdx++;
    state.groups.push(subGroup);
    await persistGroup(subGroup);
    renderGroupDetail();
    showToast(`子分组「${name}」已创建`);
  });
});

// ============================================
// Audio Alignment Engine (cross-correlation)
// ============================================

// ---- Utility helpers ----

/**
 * Remove DC offset from audio samples (subtract mean).
 * DC offset can skew energy envelope computation across devices.
 */
function removeDC(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = sum / samples.length;
  if (Math.abs(mean) < 1e-8) return samples; // already zero-mean
  const result = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) result[i] = samples[i] - mean;
  return result;
}

/**
 * Compute onset-strength envelope from an energy envelope.
 * Onsets (frame-to-frame energy increases) capture transient timing
 * and are more robust to device-level differences than raw energy.
 * Returns a new Float32Array of same length — each value is the
 * positive energy increase from the previous frame.
 */
function computeOnsetEnvelope(energies) {
  const onsets = new Float32Array(energies.length);
  onsets[0] = 0;
  for (let i = 1; i < energies.length; i++) {
    onsets[i] = Math.max(0, energies[i] - energies[i - 1]);
  }
  return onsets;
}

/**
 * Robust cross-correlation wrapper: tries energy envelope first,
 * falls back to onset-strength envelope when the energy score is weak.
 * Onset-based correlation is more resilient to microphone / codec
 * differences between iPhone and Android recordings.
 *
 * @returns {{ offset: number, score: number, method: string }}
 */
function correlateEnvelopesRobust(refEnv, tgtEnv, windowRate, maxDriftSecs = 120) {
  // 1. Try standard energy correlation first
  const energyResult = correlateEnvelopes(refEnv, tgtEnv, windowRate, maxDriftSecs);

  if (energyResult.score >= 0.25) {
    return { ...energyResult, method: 'energy' };
  }

  // 2. Energy correlation is weak — try onset-strength envelope
  const refOnsets = computeOnsetEnvelope(refEnv.energies);
  const tgtOnsets = computeOnsetEnvelope(tgtEnv.energies);

  const onsetRefEnv = { energies: refOnsets, windowRate: refEnv.windowRate };
  const onsetTgtEnv = { energies: tgtOnsets, windowRate: tgtEnv.windowRate };

  const onsetResult = correlateEnvelopes(onsetRefEnv, onsetTgtEnv, windowRate, maxDriftSecs);

  if (onsetResult.score > energyResult.score) {
    console.log(`[AudioAlign]   能量相关弱(${energyResult.score.toFixed(3)}) → 改用起音包络: ${onsetResult.score.toFixed(3)}`);
    return { ...onsetResult, method: 'onset' };
  }

  return { ...energyResult, method: 'energy' };
}

// Minimum correlation score to consider a match reliable.
// Below this threshold the videos likely do NOT share audio content
// (different events, different locations, etc.) and any offset is spurious.
const MIN_CORRELATION_SCORE = 0.18;

/**
 * Find the most distinctive ~6-second audio segment within the content region.
 *
 * Instead of cross-correlating the full audio (where quiet sections add noise),
 * we locate the segment with the highest energy concentration AND the largest
 * peak-to-valley dynamic range — the "signature" moment that is most likely to
 * produce a clean cross-correlation match across devices.
 *
 * Scoring: mean_energy × std_dev_energy  (high loudness × high contrast)
 *
 * @returns {{ start: number, end: number, score: number }} in seconds
 */
function findBestWindow(env, contentStart, contentEnd, windowSecs = 6) {
  const { energies, windowRate } = env;
  const windowFrames = Math.floor(windowRate * windowSecs);
  const startFrame = Math.floor(contentStart * windowRate);
  const endFrame = Math.min(Math.floor(contentEnd * windowRate), energies.length);

  // Content shorter than the target window — use the whole thing
  if (endFrame - startFrame < windowFrames) {
    let sum = 0, sumSq = 0;
    for (let i = startFrame; i < endFrame; i++) {
      sum += energies[i];
      sumSq += energies[i] * energies[i];
    }
    const n = Math.max(1, endFrame - startFrame);
    const mean = sum / n;
    const variance = (sumSq / n) - (mean * mean);
    const stdDev = variance > 0 ? Math.sqrt(variance) : 0;
    return {
      start: contentStart,
      end: contentEnd,
      score: mean * stdDev
    };
  }

  let bestStart = startFrame;
  let bestScore = -Infinity;
  // Slide in 0.5 s steps for efficiency
  const stepFrames = Math.max(1, Math.floor(windowRate * 0.5));

  for (let i = startFrame; i + windowFrames <= endFrame; i += stepFrames) {
    // Compute mean and std-dev in one pass
    let sum = 0, sumSq = 0;
    for (let j = i; j < i + windowFrames; j++) {
      sum += energies[j];
      sumSq += energies[j] * energies[j];
    }
    const mean = sum / windowFrames;
    const variance = (sumSq / windowFrames) - (mean * mean);
    const stdDev = variance > 0 ? Math.sqrt(variance) : 0;
    const score = mean * stdDev; // high energy × high dynamic range

    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  return {
    start: bestStart / windowRate,
    end: (bestStart + windowFrames) / windowRate,
    score: bestScore
  };
}

/**
 * Extract a mono audio sample from a video blob URL.
 * Returns a Float32Array of PCM samples, or null if no audio track.
 * @param {string} videoUrl
 * @param {number} sampleSecs - max seconds to extract (0 = full length)
 */
async function extractAudioSample(videoUrl, sampleSecs = 12) {
  let audioCtx = null;
  try {
    const response = await fetch(videoUrl);
    const arrayBuffer = await response.arrayBuffer();

    audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    // Get mono: use first channel, or average all channels
    const channels = audioBuffer.numberOfChannels;
    const maxLen = sampleSecs > 0 ? Math.floor(audioBuffer.sampleRate * sampleSecs) : audioBuffer.length;
    const length = Math.min(audioBuffer.length, maxLen);
    const mono = new Float32Array(length);

    if (channels === 1) {
      mono.set(audioBuffer.getChannelData(0).slice(0, length));
    } else {
      // Average channels
      for (let c = 0; c < channels; c++) {
        const data = audioBuffer.getChannelData(c);
        for (let i = 0; i < length; i++) {
          mono[i] += data[i] / channels;
        }
      }
    }

    return { samples: mono, sampleRate: audioBuffer.sampleRate };
  } catch (err) {
    console.warn('[AudioAlign] 提取音频失败:', err.message);
    return null;
  } finally {
    if (audioCtx) audioCtx.close();
  }
}

/**
 * Fallback audio extraction using a <video> element + Web Audio API.
 *
 * Some Android devices (e.g. Vivo, Xiaomi, Samsung mid-range) fail at
 * `decodeAudioData()` when fed a full video container — the system media
 * codec either rejects the format or runs out of memory.  The <video>
 * element uses the browser's full media pipeline (demuxer + decoder) and
 * is far more robust across manufacturers.
 *
 * We play the video silently, capture its audio output through a
 * ScriptProcessorNode, and return the same { samples, sampleRate } shape
 * as extractAudioSample.
 */
async function extractAudioViaVideoElement(videoUrl, sampleSecs = 12) {
  const video = document.createElement('video');
  video.src = videoUrl;
  video.muted = false;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.volume = 0;          // silent playback

  let audioCtx = null;

  try {
    // Wait for the video element to parse the container / load metadata
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('video load error')), { once: true });
    });

    const duration = Math.min(video.duration || 30, sampleSecs);
    const captureSecs = Math.min(duration, 300); // cap at 5 min for memory safety

    // --- Optimised capture strategy ---
    // Call play() FIRST to prime the audio decoder pipeline, then capture the
    // stream synchronously while play is still initialising.  This is the best
    // compromise between the two extremes:
    //
    //   play → capture → record        accurate timing, broken on Vivo/Xiaomi
    //                                     (capture before play returns 0 tracks)
    //   capture → record → play        works on Vivo, but on some desktop
    //                                     browsers the stream never produces data
    //
    // By interleaving play() (async) with the synchronous capture setup we
    // satisfy both: the decoder is already priming when captureStream() runs,
    // but the recorder is armed almost immediately so the t=0 offset stays
    // negligible.
    video.currentTime = 0;

    // Start playback (async — kicks off decoder initialisation)
    let playOkay = false;
    const playPromise = video.play().then(() => { playOkay = true; }).catch(playErr => {
      console.warn('[AudioAlign] 视频元素回退：play() 被拒绝:', playErr.message);
    });

    // Synchronously capture while play is priming — on desktop/iOS this
    // returns active tracks immediately; on Vivo it may still be empty.
    let stream = video.captureStream();
    let audioTracks = stream.getAudioTracks();

    // If no tracks yet, wait for play to finish and retry (Vivo path)
    if (audioTracks.length === 0) {
      console.log('[AudioAlign] 视频元素回退：播放前无音轨，等待播放完成后再捕获…');
      await playPromise;
      if (!playOkay) return null;
      // Small extra wait for decoder to finish initialising
      await new Promise(r => setTimeout(r, 150));
      stream = video.captureStream();
      audioTracks = stream.getAudioTracks();
    } else {
      // Tracks are available — wait a tick for play() to settle so the
      // stream actually carries data (avoid recording silence)
      await playPromise;
      if (!playOkay) return null;
    }

    if (audioTracks.length === 0) {
      console.warn('[AudioAlign] 视频元素回退：captureStream 无音轨 — 视频可能没有音频');
      return null;
    }

    // Create an audio-only stream
    const audioStream = new MediaStream(audioTracks);

    // Try audio/webm first (Chromium), fall back to browser default
    let mimeType = '';
    for (const candidate of ['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4']) {
      if (MediaRecorder.isTypeSupported(candidate)) {
        mimeType = candidate;
        break;
      }
    }

    const chunks = [];
    const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);

    let recorderError = null;
    recorder.onerror = (e) => {
      recorderError = e.error || new Error('MediaRecorder 错误');
      console.warn('[AudioAlign] MediaRecorder 错误:', recorderError.message);
    };

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const recorderStopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    // Video is already playing — start recorder immediately
    try {
      recorder.start();
    } catch (startErr) {
      console.warn('[AudioAlign] MediaRecorder.start() 失败:', startErr.message);
      video.pause();
      audioTracks.forEach(t => t.stop());
      return null;
    }

    // Record for the target duration
    await new Promise(r => setTimeout(r, captureSecs * 1000));

    // Some Android browsers (e.g. Vivo) auto-transition the recorder to
    // 'inactive' when the stream's audio codec can't actually be encoded.
    // Always check state before calling requestData/stop.
    if (recorder.state === 'recording') {
      recorder.requestData();
      recorder.stop();
    }
    video.pause();

    // Wait for the final dataavailable / stop event (if recorder was recording)
    await recorderStopped;

    // Detach audio tracks
    audioTracks.forEach(t => t.stop());

    if (recorderError && chunks.length === 0) {
      console.warn('[AudioAlign] 视频元素回退：MediaRecorder 出错且无数据');
      return null;
    }

    if (chunks.length === 0) {
      console.warn('[AudioAlign] 视频元素回退：MediaRecorder 未产生数据');
      return null;
    }

    const audioBlob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    const arrayBuffer = await audioBlob.arrayBuffer();

    audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = audioBuffer.length;
    const mono = new Float32Array(totalSamples);

    if (audioBuffer.numberOfChannels === 1) {
      mono.set(audioBuffer.getChannelData(0));
    } else {
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const data = audioBuffer.getChannelData(c);
        for (let i = 0; i < totalSamples; i++) {
          mono[i] += data[i] / audioBuffer.numberOfChannels;
        }
      }
    }

    console.log(`[AudioAlign] 视频元素回退成功: ${(mono.length / sampleRate).toFixed(1)}s, ${sampleRate}Hz`);
    return { samples: mono, sampleRate, _fallback: true };

  } catch (err) {
    console.warn('[AudioAlign] 视频元素回退失败:', err.message);
    return null;
  } finally {
    if (audioCtx) audioCtx.close();
    video.pause();
    video.src = '';
    video.remove();
  }
}

/**
 * Compute RMS energy envelope from PCM audio.
 * Returns { energies: Float32Array, windowRate: number } (windows per second).
 * Each value is the RMS energy in that time window — captures loudness contour.
 */
function computeEnergyEnvelope(samples, sampleRate, windowMs = 100) {
  const windowSize = Math.floor(sampleRate * (windowMs / 1000));
  if (windowSize < 1 || samples.length < windowSize) {
    // Too short — single window
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    return { energies: new Float32Array([Math.sqrt(sumSq / samples.length)]), windowRate: 1 };
  }

  const numWindows = Math.floor(samples.length / windowSize);
  const energies = new Float32Array(numWindows);

  for (let i = 0; i < numWindows; i++) {
    let sumSq = 0;
    const base = i * windowSize;
    for (let j = 0; j < windowSize; j++) {
      sumSq += samples[base + j] * samples[base + j];
    }
    energies[i] = Math.sqrt(sumSq / windowSize);
  }

  return { energies, windowRate: sampleRate / windowSize };
}

/**
 * Compute Pearson (normalised) cross-correlation between two energy envelopes.
 * Much more robust than raw-waveform correlation — works across different
 * microphones because it only cares about loudness contour, not exact phase.
 * Returns offset in seconds (positive = target is behind reference).
 * Also returns the correlation score for diagnostics.
 */
function correlateEnvelopes(refEnv, tgtEnv, windowRate, maxDriftSecs = 8) {
  const ref = refEnv.energies;
  const tgt = tgtEnv.energies;

  const maxLag = Math.floor(windowRate * maxDriftSecs);
  if (maxLag < 1) return { offset: 0, score: 0 };

  // Pre-compute means and stddevs for normalisation
  // Use the overlapping region for each lag position (sliding normalisation)
  // For efficiency, pre-compute the full means and use a simpler approach:
  // normalised cross-correlation at each lag

  let bestOffset = 0;
  let bestScore = -Infinity;

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    // Determine overlap region
    const overlapStart = Math.max(0, lag);           // in tgt indices
    const overlapEnd = Math.min(tgt.length, ref.length + lag); // in tgt indices
    const n = overlapEnd - overlapStart;
    if (n < Math.max(3, windowRate * 0.5)) continue; // need at least 0.5s of overlap

    // Compute means over the overlap region
    let sumRef = 0, sumTgt = 0;
    for (let i = 0; i < n; i++) {
      sumRef += ref[overlapStart - lag + i]; // ref index = tgt index - lag
      sumTgt += tgt[overlapStart + i];
    }
    const meanRef = sumRef / n;
    const meanTgt = sumTgt / n;

    // Compute stddevs and covariance
    let cov = 0, varRef = 0, varTgt = 0;
    for (let i = 0; i < n; i++) {
      const dr = ref[overlapStart - lag + i] - meanRef;
      const dt = tgt[overlapStart + i] - meanTgt;
      cov += dr * dt;
      varRef += dr * dr;
      varTgt += dt * dt;
    }

    // Pearson r
    const score = (varRef > 0 && varTgt > 0)
      ? cov / Math.sqrt(varRef * varTgt)
      : 0;

    if (score > bestScore) {
      bestScore = score;
      bestOffset = lag;
    }
  }

  return { offset: bestOffset / windowRate, score: bestScore };
}

/**
 * Detect where actual audio content begins and ends.
 * Uses the energy envelope with an adaptive threshold.
 * Returns { start, end } in seconds.
 */
function detectContentBoundaries(env) {
  const { energies } = env;
  const windowRate = env.windowRate; // windows per second = sampleRate / windowSamples

  if (energies.length < 2) {
    return { start: 0, end: energies.length / windowRate };
  }

  // Adaptive threshold: 15% of the median energy of the loudest third of windows
  const sorted = Array.from(energies).sort((a, b) => a - b);
  const loudThird = sorted.slice(Math.floor(energies.length * 0.67));
  const medianLoud = loudThird[Math.floor(loudThird.length / 2)] || 0.005;
  const threshold = Math.max(0.005, medianLoud * 0.15);

  // Find content start: first window exceeding threshold
  let contentStart = 0;
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] > threshold) {
      contentStart = i / windowRate;
      break;
    }
  }

  // Find content end: last window exceeding threshold
  let contentEnd = energies.length / windowRate;
  for (let i = energies.length - 1; i >= 0; i--) {
    if (energies[i] > threshold) {
      contentEnd = (i + 1) / windowRate;
      break;
    }
  }

  // Small safety padding (0.05s)
  contentStart = Math.max(0, contentStart - 0.05);
  contentEnd = Math.min(energies.length / windowRate, contentEnd + 0.05);

  return { start: contentStart, end: contentEnd };
}

/**
 * Align all filled compare slots based on audio content.
 * Auto-trims leading/trailing silence, then cross-correlates to find
 * a common time window where all videos have synchronized content.
 */
async function performAudioAlignment() {
  const filled = state.compareSlots
    .map((videoId, i) => ({ videoId, slotIdx: i }))
    .filter(s => s.videoId !== null);

  if (filled.length < 1) {
    showToast('至少需要一个视频', 'error');
    return;
  }

  btnAlignAudio.classList.add('is-processing');
  btnAlignAudio.textContent = '分析中…';
  showToast('正在提取音频、检测内容边界并对齐…');

  try {
    // --- Phase 1: extract audio from all filled slots (CONCURRENT) ---
    // CRITICAL: All extractions start simultaneously so that the fallback
    // method's video.play() calls all happen within Chrome's ~5 s user-gesture
    // window.  A sequential loop would push later slots past the deadline.
    // See [[android-audio-user-gesture-bug]] for the full history.
    const extractionResults = await Promise.all(filled.map(async (slot) => {
      const result = findVideo(slot.videoId);
      if (!result) return null;

      const fileSizeMB = (result.video.fileSize || 0) / (1024 * 1024);

      // Large files (> 50 MB): skip primary method — fetching the entire blob
      // for decodeAudioData would be too slow / memory-heavy.
      let extracted = null;
      if (fileSizeMB <= 50) {
        extracted = await extractAudioSample(result.video.url, 300);
      } else {
        console.log(`[AudioAlign] 槽位 ${slot.slotIdx}: 文件较大 (${fileSizeMB.toFixed(0)} MB)，跳过主方法，直接使用回退方案`);
      }

      // Fallback for Android / Vivo: <video> element + Web Audio API
      // (decodeAudioData often fails on Android system decoders for video containers)
      if (!extracted) {
        if (fileSizeMB <= 50) {
          console.log(`[AudioAlign] 槽位 ${slot.slotIdx}: 主方法失败，尝试视频元素回退方案…`);
        }
        extracted = await extractAudioViaVideoElement(result.video.url, 300);
      }

      if (extracted) {
        extracted.slotIdx = slot.slotIdx;
        extracted.video = result.video;
        const method = extracted._fallback ? '(视频元素回退)' : '';
        console.log(`[AudioAlign] 槽位 ${slot.slotIdx} 音频提取成功${method}: ${(extracted.samples.length / extracted.sampleRate).toFixed(1)}s, ${extracted.sampleRate}Hz`);
      } else {
        console.warn(`[AudioAlign] 槽位 ${slot.slotIdx} 音频提取失败（所有方法均失败，视频可能无音轨）`);
      }
      return extracted;
    }));

    const audioData = extractionResults;

    const valid = audioData.filter(d => d !== null && d.samples && d.samples.length > 0);
    if (valid.length < 1) {
      showToast('无法从视频中提取音频数据（所有视频均无音轨或解码失败）', 'error');
      resetAlignButton();
      return;
    }

    // --- Phase 2: compute energy envelopes, detect content boundaries,
    //            and find the most distinctive ~6 s segment per video ---
    const SILENT_THRESHOLD = 0.0005; // peak RMS < 0.0005 = essentially silent
    const WINDOW_SECS = 6;          // duration of the "signature" segment
    let hasAudibleCount = 0;

    for (const data of valid) {
      // Remove DC offset — DC can skew RMS energy differently on each device
      data.samples = removeDC(data.samples);
      data.env = computeEnergyEnvelope(data.samples, data.sampleRate, 200);
      const peakEnergy = data.env.energies.length > 0 ? Math.max(...data.env.energies) : 0;
      const videoDur = data.samples.length / data.sampleRate;

      if (peakEnergy < SILENT_THRESHOLD) {
        // Video has no audible audio — can't detect silence or correlate
        data.isSilent = true;
        data.peakEnergy = peakEnergy;
        data.contentStart = 0;
        data.contentEnd = videoDur;
        console.warn(`[AudioAlign] 槽位 ${data.slotIdx}: ⚠️ 视频无声（峰值能量=${(peakEnergy*1000).toFixed(3)}e-3 < ${(SILENT_THRESHOLD*1000).toFixed(1)}e-3），将跳过音频相关`);
      } else {
        data.isSilent = false;
        data.peakEnergy = peakEnergy;
        hasAudibleCount++;
        // Fine envelope for silence detection (50ms)
        const fineEnv = computeEnergyEnvelope(data.samples, data.sampleRate, 50);
        const bounds = detectContentBoundaries(fineEnv);
        data.contentStart = bounds.start;
        data.contentEnd = bounds.end;

        // Find the most distinctive ~6 s segment within content boundaries
        data.bestWin = findBestWindow(data.env, bounds.start, bounds.end, WINDOW_SECS);
        console.log(`[AudioAlign] 槽位 ${data.slotIdx}: 内容 ${bounds.start.toFixed(2)}s→${bounds.end.toFixed(2)}s (总长${videoDur.toFixed(1)}s), 峰值能量=${(peakEnergy*1000).toFixed(1)}e-3, 最佳窗口 ${data.bestWin.start.toFixed(2)}s→${data.bestWin.end.toFixed(2)}s (得分=${(data.bestWin.score*1000).toFixed(1)}e-3)`);
      }
    }

    // --- Store audio data for manual timeline panel ---
    // Save energy envelopes (compact) + metadata for waveform rendering.
    // Raw PCM samples are discarded after alignment to save memory.
    const groupStore = _ensureCompareGroup(state.compareGroupId);
    groupStore.audioData = new Array(COMPARE_SLOTS).fill(null);
    for (const data of valid) {
      groupStore.audioData[data.slotIdx] = {
        energyEnvelope: data.env.energies,    // 200ms-window energy (Float32Array)
        envWindowRate: data.env.windowRate,   // windows per second
        duration: data.samples.length / data.sampleRate,
        contentStart: data.contentStart,
        contentEnd: data.contentEnd,
        peakEnergy: data.peakEnergy,
        isSilent: data.isSilent || false,
        videoName: data.video?.title || `槽位 ${data.slotIdx}`,
      };
    }
    console.log(`[AudioAlign] 已保存 ${valid.length} 个视频的音频包络数据，供手动时间轴使用`);

    // If no videos have audio, we can only do a basic play-all
    if (hasAudibleCount === 0) {
      showToast('所有视频均无音频轨道，无法进行音频对齐', 'error');
      resetAlignButton();
      return;
    }

    // --- Phase 3: cross-correlate the best 6 s windows ---
    // Instead of correlating the full audio envelope (where quiet sections
    // add noise and produce spurious matches), we extract each video's most
    // distinctive ~6 s segment — highest energy concentration × dynamic range —
    // and cross-correlate only those "signature" windows.
    const audible = valid.filter(d => !d.isSilent);
    const corrOffsets = new Array(COMPARE_SLOTS).fill(0);

    if (audible.length >= 2) {
      // --- Build window envelopes for each audible video ---
      // Use a finer envelope (50 ms windows) for the 6 s segment to get
      // better time resolution during cross-correlation.
      for (const data of audible) {
        const winStartSample = Math.floor(data.bestWin.start * data.sampleRate);
        const winEndSample = Math.floor(data.bestWin.end * data.sampleRate);
        const winSamples = data.samples.slice(winStartSample, winEndSample);
        data.winEnv = computeEnergyEnvelope(winSamples, data.sampleRate, 50);
        console.log(`[AudioAlign] 槽位 ${data.slotIdx} 窗口包络: ${data.winEnv.energies.length} 帧 @ ${data.winEnv.windowRate.toFixed(1)} Hz (${(winEndSample - winStartSample) / data.sampleRate}s)`);
      }

      // --- Pick reference candidates by window score ---
      // The video whose best window has the highest score (loudest + most
      // dynamic) is the most reliable reference for correlation.
      const sortedByWinScore = [...audible].sort((a, b) => b.bestWin.score - a.bestWin.score);
      const top5 = sortedByWinScore.slice(0, Math.min(5, sortedByWinScore.length));
      const primaryRef = top5[0];

      console.log(`[AudioAlign] 🔍 最佳窗口得分最高的前 ${top5.length} 个视频作为参考基准：`);
      top5.forEach((d, i) => {
        console.log(`  ${i + 1}. 槽位${d.slotIdx} (video=${d.video?.title || '?'}) 窗口得分=${(d.bestWin.score*1000).toFixed(1)}e-3, 窗口位置=${d.bestWin.start.toFixed(2)}s→${d.bestWin.end.toFixed(2)}s`);
      });

      // Correlate each non-primary video's window against the primary ref's window.
      // maxDrift for a 6 s window is capped at 4 s — this guarantees at least 2 s
      // of overlap and prevents the correlation from wandering into noise.
      const WINDOW_MAX_DRIFT = 4;

      for (const tgt of audible) {
        if (tgt === primaryRef) continue; // reference has zero offset

        const avgRate = (primaryRef.winEnv.windowRate + tgt.winEnv.windowRate) / 2;
        const result = correlateEnvelopesRobust(primaryRef.winEnv, tgt.winEnv, avgRate, WINDOW_MAX_DRIFT);

        // winCorrOffset: positive = tgt's window content is behind primaryRef's window
        const winCorrOffset = result.offset;

        // Convert window alignment to full-video alignment:
        // The same real-world moment maps to:
        //   primaryRef at bestWin.start[primaryRef]
        //   tgt         at bestWin.start[tgt] - winCorrOffset
        // So tgt is shifted relative to primaryRef by:
        //   (bestWin.start[tgt] - winCorrOffset) - bestWin.start[primaryRef]
        const fullOffset = tgt.bestWin.start - primaryRef.bestWin.start - winCorrOffset;

        if (result.score >= MIN_CORRELATION_SCORE) {
          corrOffsets[tgt.slotIdx] = fullOffset;
        } else {
          corrOffsets[tgt.slotIdx] = 0;
          tgt._unreliableCorr = true;
        }

        const reliable = result.score >= MIN_CORRELATION_SCORE
          ? (result.score > 0.3 ? '✓可信' : '△可接受')
          : '✗不可靠（得分过低，视频可能不属同一事件）';
        console.log(`[AudioAlign] 槽位${tgt.slotIdx} vs 主参考槽位${primaryRef.slotIdx}: 窗偏移=${winCorrOffset.toFixed(3)}s, 得分=${result.score.toFixed(3)} ${reliable}, 最终偏移=${corrOffsets[tgt.slotIdx].toFixed(3)}s (bestWin: ${tgt.bestWin.start.toFixed(2)}s vs ${primaryRef.bestWin.start.toFixed(2)}s)`);
      }

      // Count how many audible videos have unreliable correlation
      const unreliableCount = audible.filter(d => d._unreliableCorr).length;
      if (unreliableCount > 0) {
        console.warn(`[AudioAlign] ⚠️ ${unreliableCount}/${audible.length - 1} 个非参考视频的相关性低于阈值 ${MIN_CORRELATION_SCORE}——这些视频的音频内容可能不相关（不同事件/地点）`);
      }
    } else {
      // Only one audible video — can't cross-correlate, just trim its silence
      console.log(`[AudioAlign] 仅 ${audible.length} 个视频有音频，跳过互相关（仅进行静音裁剪）`);
    }

    // --- Phase 4: find common overlapping time window (audible videos only) ---
    // Silent videos can't be placed on the common timeline — they just play from 0
    let commonStart = -Infinity;
    let commonEnd = Infinity;

    for (const data of audible) {
      // tgt's own time t → ref timeline = t - corrOffset
      const adjStart = data.contentStart - (corrOffsets[data.slotIdx] || 0);
      const adjEnd = data.contentEnd - (corrOffsets[data.slotIdx] || 0);
      console.log(`[AudioAlign] 槽位 ${data.slotIdx} 参考时间轴: ${adjStart.toFixed(2)}s → ${adjEnd.toFixed(2)}s`);
      if (adjStart > commonStart) commonStart = adjStart;
      if (adjEnd < commonEnd) commonEnd = adjEnd;
    }

    // Sanity check
    if (commonEnd <= commonStart || !isFinite(commonStart) || !isFinite(commonEnd)) {
      console.warn(`[AudioAlign] 共同窗口无效，回退到默认`);
      commonStart = 0;
      commonEnd = Math.min(...audible.map(d => d.contentEnd));
    }

    const commonDuration = commonEnd - commonStart;
    console.log(`[AudioAlign] 共同窗口（有声视频）: ${commonStart.toFixed(2)}s → ${commonEnd.toFixed(2)}s (时长 ${commonDuration.toFixed(2)}s)`);

    // --- Phase 5: compute per-slot seek positions ---
    // Video i's own time t → ref timeline = t - corrOffset_i
    // We want ref timeline = commonStart, so: seek_i = commonStart + corrOffset_i
    const offsets = new Array(COMPARE_SLOTS).fill(0);

    for (const data of audible) {
      const corr = corrOffsets[data.slotIdx] || 0;
      const seek = commonStart + corr;
      offsets[data.slotIdx] = Math.max(0, seek);
      console.log(`[AudioAlign] 槽位 ${data.slotIdx} (有声): seek→${offsets[data.slotIdx].toFixed(2)}s (contentStart=${data.contentStart.toFixed(2)}s, corr=${corr.toFixed(3)}s)`);
    }

    for (const data of valid) {
      if (data.isSilent) {
        offsets[data.slotIdx] = 0; // Always start silent videos from beginning
        const dur = data.samples.length / data.sampleRate;
        console.log(`[AudioAlign] 槽位 ${data.slotIdx} (无声): seek→0.00s (从头播放，总长${dur.toFixed(1)}s，无音频可对齐)`);
      }
    }

    // --- Compute playback duration: shortest remaining video after seek ---
    // Instead of using the intersection of content windows (which can be very short),
    // use the video that runs out first as the common playback duration.
    // This gives a much longer synchronized playback experience.
    let commonDurationFromRemaining = Infinity;
    for (const data of valid) {
      const videoDuration = data.video?.duration;
      if (videoDuration && videoDuration > 0) {
        const remaining = videoDuration - offsets[data.slotIdx];
        if (remaining > 0 && remaining < commonDurationFromRemaining) {
          commonDurationFromRemaining = remaining;
        }
      }
    }
    // Fall back to content-window intersection if we couldn't determine remaining durations
    if (!isFinite(commonDurationFromRemaining) || commonDurationFromRemaining <= 0) {
      commonDurationFromRemaining = commonEnd - commonStart;
      console.log(`[AudioAlign] 无法获取视频时长，回退到内容窗口交集: ${commonDurationFromRemaining.toFixed(2)}s`);
    }
    const commonDurationFinal = commonDurationFromRemaining;
    console.log(`[AudioAlign] 播放时长（最短剩余视频）: ${commonDurationFinal.toFixed(2)}s (内容窗口交集为 ${(commonEnd - commonStart).toFixed(2)}s)`);

    state.compareOffsets = offsets;
    state.compareDuration = commonDurationFinal;

    // Persist alignment so it survives page reloads and is available
    // when returning to this group's compare view later
    persistCompareState(state.compareGroupId);

    // --- Show result ---
    const silentCount = valid.length - audible.length;
    const unreliableCount = audible.filter(d => d._unreliableCorr).length;
    const reliableAudible = audible.length - unreliableCount;
    const top5Count = Math.min(5, audible.length);

    let msg, toastType = 'success';
    if (reliableAudible >= 2) {
      msg = `对齐完成：以波峰最高的 ${top5Count} 个视频为基准`;
      if (silentCount > 0) {
        msg += `（${silentCount} 个视频无音频）`;
      }
      if (unreliableCount > 0) {
        msg += `，${unreliableCount} 个视频音频不相关已跳过`;
      }
      msg += `，同步播放 ${commonDurationFinal.toFixed(1)}s`;
    } else if (reliableAudible === 1) {
      msg = `仅 1 个视频有可靠音频，无法互相关对齐——已根据内容边界裁剪静音`;
      toastType = '';
    } else {
      msg = `所有视频音频均不相关——可能不属同一事件，各视频将从头同步播放`;
      toastType = 'error';
    }
    showToast(msg, toastType);

    btnAlignAudio.classList.remove('is-processing');
    if (reliableAudible >= 2 || (reliableAudible === 1 && silentCount === 0)) {
      btnAlignAudio.classList.add('is-aligned');
      btnAlignAudio.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4,12 8,5 12,19 16,9 20,12"/>
        </svg>
        已对齐`;
    } else {
      syncAlignButton();
    }

    // Auto-open the timeline panel to show alignment result
    state.timelineVisible = true;

    // Re-render to show the new offsets
    renderCompareView();
  } catch (err) {
    console.error('[AudioAlign] 对齐失败:', err);
    showToast('音频对齐失败，请重试', 'error');
    resetAlignButton();
  }
}

function resetAlignButton() {
  btnAlignAudio.classList.remove('is-processing', 'is-aligned');
  syncAlignButton();
}

/**
 * Reset alignment offsets and button state.
 */
function clearAudioAlignment() {
  state.compareOffsets = new Array(COMPARE_SLOTS).fill(0);
  state.compareDuration = null;
  // Also clear audio data and commonStart for manual timeline
  const groupStore = state.compareGroupId ? state._compareByGroup[state.compareGroupId] : null;
  if (groupStore) {
    groupStore.audioData = new Array(COMPARE_SLOTS).fill(null);
    groupStore.commonStart = 0;
  }
  // Also wipe persisted alignment so stale data doesn't appear on reload
  persistCompareState(state.compareGroupId);
  syncAlignButton();
}

/**
 * Persist the compare state (offsets + duration) for a group to IndexedDB
 * so that alignment survives page reloads.
 */
async function persistCompareState(groupId) {
  if (!groupId) return;
  try {
    const db = await openDB();
    const tx = db.transaction('groups', 'readwrite');
    const store = tx.objectStore('groups');
    const req = store.get(groupId);
    const record = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!record) return;
    const compareState = state._compareByGroup[groupId];
    if (compareState) {
      record.compareOffsets = [...compareState.offsets];
      record.compareDuration = compareState.duration;
      record.commonStart = compareState.commonStart || 0;
      // Persist audio envelopes (compact, not raw PCM) for waveform display
      if (compareState.audioData) {
        record.audioData = compareState.audioData.map(d => d ? {
          energyEnvelope: Array.from(d.energyEnvelope),
          envWindowRate: d.envWindowRate,
          duration: d.duration,
          contentStart: d.contentStart,
          contentEnd: d.contentEnd,
          peakEnergy: d.peakEnergy,
          isSilent: d.isSilent,
          videoName: d.videoName,
        } : null);
      }
    }
    store.put(record);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[FilmArchive] 保存对比状态失败:', err.message);
  }
}

/**
 * Debug / test helper — call from the browser console:
 *   await debugAlignGroup('夕阳拍摄')
 *
 * Loads all videos from the named group into compare slots and runs the
 * alignment, printing detailed per-slot diagnostics (including extraction
 * method, correlation scores, and whether onset fallback was used).
 */
async function debugAlignGroup(groupName) {
  // 1. Find group by name (case-insensitive substring match)
  const group = state.groups.find(g => g.name.toLowerCase().includes(groupName.toLowerCase()));
  if (!group) {
    console.error(`[DebugAlign] 未找到包含 "${groupName}" 的分组`);
    console.log('可用的分组:', state.groups.map(g => g.name));
    return;
  }
  console.log(`[DebugAlign] 找到分组: "${group.name}" (id=${group.id}), ${group.videos.length} 个视频`);

  // 2. Navigate to compare view targeting this group
  state.compareGroupId = group.id;
  navigate('compare', group.id);

  // 3. Fill compare slots with videos from the group
  const slotsToFill = Math.min(group.videos.length, COMPARE_SLOTS);
  for (let i = 0; i < slotsToFill; i++) {
    state.compareSlots[i] = group.videos[i].id;
    console.log(`[DebugAlign] 槽位 ${i}: "${group.videos[i].title}" (${group.videos[i].originalName || '?'}) size=${(group.videos[i].fileSize / 1048576).toFixed(1)}MB`);
  }
  for (let i = slotsToFill; i < COMPARE_SLOTS; i++) {
    state.compareSlots[i] = null;
  }

  // Compare state is auto-saved via property setters when compareGroupId is set
  // (state.compareSlots is a property proxy to _compareByGroup[gid].slots)

  // 4. Render compare view and run alignment
  renderCompareView();

  // Small delay so the UI settles
  await new Promise(r => setTimeout(r, 300));

  console.log(`[DebugAlign] 开始音频对齐 (${slotsToFill} 个视频)…`);
  console.log(`[DebugAlign] 算法: 并发提取 + DC去除 + 起音包络回退 (当能量相关 < 0.25 时)`);

  const startTime = performance.now();
  await performAudioAlignment();
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

  // 5. Print results summary
  console.log(`[DebugAlign] ✅ 对齐完成 (耗时 ${elapsed}s)`);
  console.log('[DebugAlign] 最终 seek 位置:', state.compareOffsets);
  console.log('[DebugAlign] 共同片段时长:', state.compareDuration?.toFixed(2) + 's');
  console.log('[DebugAlign] 💡 提示: 在浏览器中播放以验证对齐效果，查看控制台获取各槽位详情');
}

// Expose for console use
window.debugAlignGroup = debugAlignGroup;
console.log('[Dev] 调试函数已就绪 — 在控制台输入 await debugAlignGroup("夕阳拍摄") 进行测试');

function updateRenderButtonState() {
  const filled = state.compareSlots.filter(s => s !== null);
  const allRendered = filled.length > 0 && filled.every(videoId => {
    const result = findVideo(videoId);
    return result && result.video.renderedUrl;
  });

  btnRenderAll.classList.remove('is-rendered', 'is-processing');
  if (allRendered) {
    btnRenderAll.classList.add('is-rendered');
    btnRenderAll.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <polyline points="2,21 12,13 22,21"/>
      </svg>
      重新渲染`;
  } else {
    btnRenderAll.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <polyline points="2,21 12,13 22,21"/>
      </svg>
      渲染`;
  }
}

// Bind align button
btnAlignAudio.addEventListener('click', performAudioAlignment);

// ============================================
// Video Render Engine (proxy generation for smooth playback)
// ============================================

/**
 * Render a video to a lower-resolution proxy using Canvas + MediaRecorder.
 * Returns a Blob of the rendered webm video (no audio — proxy is for visual only).
 */
async function renderVideoToProxy(originalUrl, onProgress, rotation = 0) {
  const video = document.createElement('video');
  video.src = originalUrl;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;

  // Wait for metadata
  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', reject, { once: true });
  });

  const duration = video.duration;
  if (!duration || !isFinite(duration)) {
    throw new Error('无法读取视频时长');
  }

  // --- Phase 1: detect native frame rate ---
  // Play a short segment (~1s) and count frames via requestVideoFrameCallback.
  let detectedFps = 30; // fallback default
  const hasVFC = 'requestVideoFrameCallback' in video;
  if (hasVFC) {
    video.currentTime = 0;
    await video.play();

    let frameCount = 0;
    const detectStart = performance.now();
    await new Promise((resolve) => {
      const onFrame = (now, metadata) => {
        frameCount++;
        if (metadata.presentedFrames > 0 && metadata.presentedFrames < 3) {
          // First few frames may be irregular — keep counting
        }
        if (performance.now() - detectStart >= 800) {
          resolve();
          return;
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    });

    const detectElapsed = (performance.now() - detectStart) / 1000;
    if (detectElapsed > 0 && frameCount > 0) {
      detectedFps = Math.round(frameCount / detectElapsed);
      // Clamp to reasonable range
      detectedFps = Math.max(10, Math.min(60, detectedFps));
    }
    video.pause();
  }

  // --- Phase 2: render at 1080p max with native frame rate ---
  // Scale down to 1080p if larger; keep original if already ≤ 1080p
  const MAX_DIM = 1080;
  let w = video.videoWidth;
  let h = video.videoHeight;
  // For 90/270 rotation, swap visual dimensions (canvas will be swapped too)
  const isRotated90 = rotation === 90 || rotation === 270;
  const visualW = isRotated90 ? h : w;
  const visualH = isRotated90 ? w : h;
  if (Math.max(visualW, visualH) > MAX_DIM) {
    const scale = MAX_DIM / Math.max(visualW, visualH);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  // Ensure even dimensions (some codecs require this)
  w = w % 2 === 0 ? w : w + 1;
  h = h % 2 === 0 ? h : h + 1;

  // Canvas uses visual dimensions (swapped for 90/270 rotations)
  const canvasW = isRotated90 ? h : w;
  const canvasH = isRotated90 ? w : h;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Capture at native frame rate
  const stream = canvas.captureStream(detectedFps);

  // Check for supported codec
  const mimeType = MediaRecorder.isTypeSupported('video/webm; codecs=vp9')
    ? 'video/webm; codecs=vp9'
    : MediaRecorder.isTypeSupported('video/webm; codecs=vp8')
      ? 'video/webm; codecs=vp8'
      : 'video/webm';

  // Scale bitrate proportionally to resolution (base: 2Mbps for 720p-equivalent area)
  const REF_AREA = 1280 * 720;     // 921,600 px → 2 Mbps reference
  const actualArea = canvasW * canvasH;
  const scaledBitrate = Math.max(2000000, Math.round(2000000 * (actualArea / REF_AREA)));

  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: scaledBitrate,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const recordingDone = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });

  // Start recording and playback
  recorder.start();
  video.currentTime = 0;
  await video.play();

  // Frame draw loop — use requestVideoFrameCallback when available to sync
  // with the video's native frame timing; fall back to rAF otherwise.
  const drawFrame = () => {
    if (video.ended || (video.paused && video.currentTime >= duration - 0.1)) {
      recorder.stop();
      return;
    }

    // Apply rotation if needed (match CSS rotation in compare view)
    if (rotation !== 0) {
      ctx.save();
      ctx.translate(canvasW / 2, canvasH / 2);
      if (rotation === 90) ctx.rotate(Math.PI / 2);
      else if (rotation === 180) ctx.rotate(Math.PI);
      else if (rotation === 270) ctx.rotate(-Math.PI / 2);
      ctx.drawImage(video, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(video, 0, 0, w, h);
    }

    // Progress callback
    if (onProgress && duration > 0) {
      onProgress(Math.min(video.currentTime / duration, 1));
    }

    if (hasVFC) {
      video.requestVideoFrameCallback(drawFrame);
    } else {
      requestAnimationFrame(drawFrame);
    }
  };

  if (hasVFC) {
    video.requestVideoFrameCallback(drawFrame);
  } else {
    drawFrame();
  }

  // Wait for video to finish
  await new Promise((resolve) => {
    video.addEventListener('ended', resolve, { once: true });
    video.addEventListener('error', resolve, { once: true });
  });

  // Ensure recorder stops
  if (recorder.state === 'recording') {
    // Small delay to capture final frames
    await new Promise(r => setTimeout(r, 200));
    recorder.stop();
  }

  await recordingDone;

  // Cleanup
  video.pause();
  video.src = '';
  stream.getTracks().forEach(t => t.stop());

  if (chunks.length === 0) {
    throw new Error('渲染失败：没有生成视频数据');
  }

  const renderedBlob = new Blob(chunks, { type: mimeType });
  return renderedBlob;
}

/**
 * Render (or re-render) all videos currently in compare slots.
 * Old proxy blobs are cleaned up and replaced with new renders.
 */
async function performRenderAll() {
  const filled = state.compareSlots
    .map((videoId, i) => ({ videoId, slotIdx: i }))
    .filter(s => s.videoId !== null);

  if (filled.length === 0) {
    showToast('对比槽中没有视频', 'error');
    return;
  }

  // Collect all videos with their data
  const toRender = [];
  for (const slot of filled) {
    const result = findVideo(slot.videoId);
    if (result) {
      toRender.push({ ...slot, video: result.video, group: result.group });
    }
  }

  btnRenderAll.classList.add('is-processing');
  btnRenderAll.innerHTML = '<span class="compare__render-progress"></span>渲染中…';

  let completed = 0;
  const total = toRender.length;

  for (const item of toRender) {
    showToast(`正在渲染 ${completed + 1}/${total} — ${item.video.title}`);

    try {
      const renderedBlob = await renderVideoToProxy(item.video.url, (progress) => {
        const pct = Math.round(progress * 100);
        btnRenderAll.innerHTML = `<span class="compare__render-progress"></span>${completed + 1}/${total} — ${pct}%`;
      }, item.video.rotation || 0);

      // Clean up old rendered URL before replacing
      if (item.video.renderedUrl) {
        URL.revokeObjectURL(item.video.renderedUrl);
      }

      // Create blob URL and persist
      const renderedUrl = URL.createObjectURL(renderedBlob);
      item.video.renderedUrl = renderedUrl;
      await persistRenderedVideo(item.video.id, renderedBlob);

      completed++;
    } catch (err) {
      console.error('[Render] 渲染失败:', item.video.title, err);
      completed++;
    }
  }

  // Done
  btnRenderAll.classList.remove('is-processing');
  updateRenderButtonState();

  showToast(`渲染完成：${completed}/${total}`, completed === total ? 'success' : 'error');

  // Refresh compare view to use rendered versions
  renderCompareView();
}

// Bind render button
btnRenderAll.addEventListener('click', performRenderAll);

// ============================================
// Compare View
// ============================================
function renderCompareView() {
  renderCompareGroupTree();
  renderCompareChips();
  renderCompareSlots();
  updateCompareMaster();
  updateRenderButtonState();
  syncAlignButton(); // sync button state with current group's alignment
  syncTimelineButton(); // sync timeline toggle button state
  // Set filled count for adaptive fullscreen grid
  const filled = state.compareSlots.filter(s => s !== null).length;
  compareSlotsEl.setAttribute('data-filled', filled);
  // Render timeline panel if visible
  if (state.timelineVisible) {
    renderTimelinePanel();
    startTimelinePlaybackCursor();
  }
}

/**
 * Sync the audio-align button visual state with the CURRENT group's actual
 * alignment data.  Without this the button leaks across groups — switching
 * from an aligned group to an unaligned one still shows "已对齐".
 */
function syncAlignButton() {
  const hasAligned = state.compareOffsets.some(o => o !== 0) && state.compareDuration !== null;
  if (hasAligned) {
    btnAlignAudio.classList.add('is-aligned');
    btnAlignAudio.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="4,12 8,5 12,19 16,9 20,12"/>
      </svg>
      已对齐`;
  } else {
    btnAlignAudio.classList.remove('is-aligned');
    btnAlignAudio.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="4,12 8,5 12,19 16,9 20,12"/>
      </svg>
      音频对齐`;
  }
}

function renderCompareChips() {
  compareChips.innerHTML = '';

  const group = findGroup(state.compareGroupId);
  const videos = group ? getGroupAllVideos(group) : [];

  // Group tree is rendered separately in renderCompareView

  if (videos.length === 0) {
    compareChips.innerHTML = '<span style="color:#666;font-size:0.75rem;">该分组暂无视频</span>';
    return;
  }

  videos.forEach(v => {
    const chip = document.createElement('span');
    chip.className = 'compare-chip';
    chip.draggable = true;
    chip.dataset.videoId = v.id;
    chip.dataset.sourceGroupId = v.groupId;
    if (state.compareSlots.includes(v.id)) chip.classList.add('compare-chip--active');
    chip.textContent = v.title;
    chip.addEventListener('click', () => toggleCompareSlot(v));
    chip.addEventListener('dragstart', (e) => {
      chip.classList.add('is-dragging');
      e.dataTransfer.setData('application/video-id', v.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('is-dragging');
    });
    compareChips.appendChild(chip);
  });
}

// ── Group folder tree (replaces <select> dropdown) ──
// State: Set of expanded group IDs (persisted across re-renders)
let _expandedGroups = new Set();

function renderCompareGroupTree() {
	if (state.groups.length === 0) { compareGroupTree.innerHTML = ''; return; }

	// Save current scroll position
	const scrollTop = compareGroupTree.scrollTop;

	compareGroupTree.innerHTML = '';

	// Collect groups that need to be shown
	const shown = new Set();
	let anyItem = false;

	// 1. Root groups (大组) — become expandable folders
	const rootGroups = state.groups.filter(g => !g.parentId);

	rootGroups.forEach(root => {
		const children = getChildGroups(root.id);
		const childrenWithVideos = children.filter(c => getGroupVideoCount(c) > 0);
		const rootHasOwnVideos = root.videos.length > 0;
		const rootTotalVideos = getGroupVideoCount(root);

		if (rootTotalVideos === 0) return;
		anyItem = true;

		const hasChildren = childrenWithVideos.length > 0;

		// Build the root folder item
		const folder = document.createElement('div');
		folder.className = 'tree-folder';
		if (state.compareGroupId === root.id) folder.classList.add('tree-folder--active');
		folder.dataset.groupId = root.id;

		// Toggle arrow
		const toggle = document.createElement('span');
		toggle.className = 'tree-toggle';
		if (!hasChildren) toggle.classList.add('tree-toggle--hidden');
		else if (_expandedGroups.has(root.id)) toggle.classList.add('tree-toggle--open');
		toggle.textContent = '▶';
		folder.appendChild(toggle);

		// Icon
		const icon = document.createElement('span');
		icon.className = 'tree-icon';
		icon.textContent = hasChildren ? '📁' : '📄';
		folder.appendChild(icon);

		// Name
		const name = document.createElement('span');
		name.className = 'tree-name';
		name.textContent = root.name;
		folder.appendChild(name);

		// Count
		const count = document.createElement('span');
		count.className = 'tree-count';
		count.textContent = `${rootTotalVideos}个视频`;
		folder.appendChild(count);

		// Click handler
		folder.addEventListener('click', (e) => {
			// If clicked on the toggle arrow → expand/collapse
			if (e.target === toggle) {
				e.stopPropagation();
				if (_expandedGroups.has(root.id)) {
					_expandedGroups.delete(root.id);
				} else {
					_expandedGroups.add(root.id);
				}
				renderCompareGroupTree();
				return;
			}
			// Otherwise → select this group
			state.compareGroupId = root.id;
			pauseAllCompareSlots();
			state.compareIsPlaying = false;
			renderCompareView();
		});

		folder.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'move';
			folder.classList.add('drag-over');
		});
		folder.addEventListener('dragleave', () => {
			folder.classList.remove('drag-over');
		});
		folder.addEventListener('drop', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			folder.classList.remove('drag-over');
			const videoId = e.dataTransfer.getData('application/video-id');
			if (!videoId) return;
			const targetName = folder.querySelector('.tree-name').textContent;
			if (await moveVideoToGroup(videoId, folder.dataset.groupId)) {
				showToast('已移入「' + targetName + '」');
				renderCompareView();
			}
		});

		compareGroupTree.appendChild(folder);
		shown.add(root.id);

		// Pre-mark all children/grandchildren as part of this tree (even when collapsed)
		childrenWithVideos.forEach(child => {
			shown.add(child.id);
			getChildGroups(child.id).filter(c => getGroupVideoCount(c) > 0).forEach(gc => shown.add(gc.id));
		});

		// Render children if expanded
		if (hasChildren && _expandedGroups.has(root.id)) {
			childrenWithVideos.forEach(child => {
				const childFolder = document.createElement('div');
				childFolder.className = 'tree-folder';
				childFolder.dataset.depth = '1';
				if (state.compareGroupId === child.id) childFolder.classList.add('tree-folder--active');
				childFolder.dataset.groupId = child.id;

				// Grandchildren toggle (for deeper nesting)
				const grandChildren = getChildGroups(child.id).filter(c => getGroupVideoCount(c) > 0);
				const childHasChildren = grandChildren.length > 0;

				const childToggle = document.createElement('span');
				childToggle.className = 'tree-toggle';
				if (!childHasChildren) childToggle.classList.add('tree-toggle--hidden');
				else if (_expandedGroups.has(child.id)) childToggle.classList.add('tree-toggle--open');
				childToggle.textContent = '▶';
				childFolder.appendChild(childToggle);

				const childIcon = document.createElement('span');
				childIcon.className = 'tree-icon';
				childIcon.textContent = childHasChildren ? '📁' : '📄';
				childFolder.appendChild(childIcon);

				const childName = document.createElement('span');
				childName.className = 'tree-name';
				childName.textContent = child.name;
				childFolder.appendChild(childName);

				const childCount = document.createElement('span');
				childCount.className = 'tree-count';
				const childVc = getGroupVideoCount(child);
				childCount.textContent = `${childVc}个视频`;
				childFolder.appendChild(childCount);

				childFolder.addEventListener('click', (e) => {
					if (e.target === childToggle) {
						e.stopPropagation();
						if (_expandedGroups.has(child.id)) {
							_expandedGroups.delete(child.id);
						} else {
							_expandedGroups.add(child.id);
						}
						renderCompareGroupTree();
						return;
					}
					state.compareGroupId = child.id;
					pauseAllCompareSlots();
					state.compareIsPlaying = false;
					renderCompareView();
				});

		childFolder.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'move';
			childFolder.classList.add('drag-over');
		});
		childFolder.addEventListener('dragleave', () => {
			childFolder.classList.remove('drag-over');
		});
		childFolder.addEventListener('drop', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			childFolder.classList.remove('drag-over');
			const videoId = e.dataTransfer.getData('application/video-id');
			if (!videoId) return;
			const targetName = childFolder.querySelector('.tree-name').textContent;
			if (await moveVideoToGroup(videoId, childFolder.dataset.groupId)) {
				showToast('已移入「' + targetName + '」');
				renderCompareView();
			}
		});

				compareGroupTree.appendChild(childFolder);

				// Level-2 children (grandchildren)
				if (childHasChildren && _expandedGroups.has(child.id)) {
					grandChildren.forEach(gc => {
						const gcFolder = document.createElement('div');
						gcFolder.className = 'tree-folder';
						gcFolder.dataset.depth = '2';
						if (state.compareGroupId === gc.id) gcFolder.classList.add('tree-folder--active');
						gcFolder.dataset.groupId = gc.id;

						const gcToggle = document.createElement('span');
						gcToggle.className = 'tree-toggle tree-toggle--hidden';
						gcFolder.appendChild(gcToggle);

						const gcIcon = document.createElement('span');
						gcIcon.className = 'tree-icon';
						gcIcon.textContent = '📄';
						gcFolder.appendChild(gcIcon);

						const gcName = document.createElement('span');
						gcName.className = 'tree-name';
						gcName.textContent = gc.name;
						gcFolder.appendChild(gcName);

						const gcCount = document.createElement('span');
						gcCount.className = 'tree-count';
						gcCount.textContent = `${getGroupVideoCount(gc)}个视频`;
						gcFolder.appendChild(gcCount);

						gcFolder.addEventListener('click', () => {
							state.compareGroupId = gc.id;
							pauseAllCompareSlots();
							state.compareIsPlaying = false;
							renderCompareView();
						});

		gcFolder.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'move';
			gcFolder.classList.add('drag-over');
		});
		gcFolder.addEventListener('dragleave', () => {
			gcFolder.classList.remove('drag-over');
		});
		gcFolder.addEventListener('drop', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			gcFolder.classList.remove('drag-over');
			const videoId = e.dataTransfer.getData('application/video-id');
			if (!videoId) return;
			const targetName = gcFolder.querySelector('.tree-name').textContent;
			if (await moveVideoToGroup(videoId, gcFolder.dataset.groupId)) {
				showToast('已移入「' + targetName + '」');
				renderCompareView();
			}
		});

						compareGroupTree.appendChild(gcFolder);
					});
				}
			});
		}
	});

	// 2. Orphaned / standalone groups
	state.groups.forEach(g => {
		if (shown.has(g.id)) return;
		const videoCount = getGroupVideoCount(g);
		if (videoCount === 0) return;
		anyItem = true;

		const folder = document.createElement('div');
		folder.className = 'tree-folder';
		if (state.compareGroupId === g.id) folder.classList.add('tree-folder--active');
		folder.dataset.groupId = g.id;

		const toggle = document.createElement('span');
		toggle.className = 'tree-toggle tree-toggle--hidden';
		folder.appendChild(toggle);

		const icon = document.createElement('span');
		icon.className = 'tree-icon';
		icon.textContent = '📄';
		folder.appendChild(icon);

		const name = document.createElement('span');
		name.className = 'tree-name';
		name.textContent = g.name;
		folder.appendChild(name);

		const count = document.createElement('span');
		count.className = 'tree-count';
		count.textContent = `${videoCount}个视频`;
		folder.appendChild(count);

		folder.addEventListener('click', () => {
			state.compareGroupId = g.id;
			pauseAllCompareSlots();
			state.compareIsPlaying = false;
			renderCompareView();
		});

		folder.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'move';
			folder.classList.add('drag-over');
		});
		folder.addEventListener('dragleave', () => {
			folder.classList.remove('drag-over');
		});
		folder.addEventListener('drop', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			folder.classList.remove('drag-over');
			const videoId = e.dataTransfer.getData('application/video-id');
			if (!videoId) return;
			const targetName = folder.querySelector('.tree-name').textContent;
			if (await moveVideoToGroup(videoId, folder.dataset.groupId)) {
				showToast('已移入「' + targetName + '」');
				renderCompareView();
			}
		});

		compareGroupTree.appendChild(folder);
	});

	if (!anyItem) {
		compareGroupTree.innerHTML = '<div class="tree-empty">暂无含视频的分组</div>';
	}

	// Restore scroll position
	compareGroupTree.scrollTop = scrollTop;
}

function toggleCompareSlot(video) {
  const slotIdx = state.compareSlots.indexOf(video.id);
  if (slotIdx !== -1) {
    // Already in a slot — remove it
    state.compareSlots[slotIdx] = null;
    // Also clear audio data for this slot so the old waveform doesn't linger
    const gStore = state.compareGroupId ? state._compareByGroup[state.compareGroupId] : null;
    if (gStore && gStore.audioData) {
      gStore.audioData[slotIdx] = null;
    }
  } else {
    // Find first empty slot
    const emptyIdx = state.compareSlots.indexOf(null);
    if (emptyIdx !== -1) {
      state.compareSlots[emptyIdx] = video.id;
    }
    // If no empty slot, do nothing (all 8 slots full)
  }
  pauseAllCompareSlots();
  state.compareIsPlaying = false;
  clearAudioAlignment();
  updateRenderButtonState();
  renderCompareView();
}

function renderCompareSlots() {
  compareSlotsEl.innerHTML = '';

  for (let i = 0; i < COMPARE_SLOTS; i++) {
    const videoId = state.compareSlots[i];
    const slotEl = document.createElement('div');
    slotEl.className = 'compare-slot';
    slotEl.dataset.slot = i;
    slotEl.draggable = true;

    // --- Drag event handlers ---
    slotEl.addEventListener('dragstart', (e) => {
      slotEl.classList.add('is-dragging');
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
    });

    slotEl.addEventListener('dragend', () => {
      slotEl.classList.remove('is-dragging');
      // Remove drag-over from all slots
      compareSlotsEl.querySelectorAll('.compare-slot').forEach(s => s.classList.remove('drag-over'));
    });

    slotEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      slotEl.classList.add('drag-over');
    });

    slotEl.addEventListener('dragleave', () => {
      slotEl.classList.remove('drag-over');
    });

    slotEl.addEventListener('drop', (e) => {
      e.preventDefault();
      slotEl.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (isNaN(fromIdx) || fromIdx === i) return;

      // Swap the two slots (and their alignment offsets + audio data)
      const temp = state.compareSlots[fromIdx];
      state.compareSlots[fromIdx] = state.compareSlots[i];
      state.compareSlots[i] = temp;

      const tempOffset = state.compareOffsets[fromIdx];
      state.compareOffsets[fromIdx] = state.compareOffsets[i];
      state.compareOffsets[i] = tempOffset;

      const groupStore = state.compareGroupId ? state._compareByGroup[state.compareGroupId] : null;
      if (groupStore && groupStore.audioData) {
        const tempAudio = groupStore.audioData[fromIdx];
        groupStore.audioData[fromIdx] = groupStore.audioData[i];
        groupStore.audioData[i] = tempAudio;
      }

      // Offsets travel with their videos — no need to re-align
      // Save the swapped state so it survives page reload
      persistCompareState(state.compareGroupId);

      pauseAllCompareSlots();
      state.compareIsPlaying = false;
      renderCompareView();
    });

    const inner = document.createElement('div');
    inner.className = 'compare-slot__inner';

    if (videoId) {
      slotEl.classList.add('has-video');
      const result = findVideo(videoId);
      if (result) {
        // Apply rotation from video metadata
        const rotation = result.video.rotation || 0;
        slotEl.setAttribute('data-rotation', rotation);

        // Use rendered proxy or original based on stored preference
        const preferProxy = !!(result.video.useProxy && result.video.renderedUrl);
        const srcUrl = preferProxy ? result.video.renderedUrl : result.video.url;
        const vid = document.createElement('video');
        vid.src = srcUrl;
        vid.preload = 'metadata';
        vid.playsInline = true;
        vid.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
        inner.appendChild(vid);

        // Apply rotation transform after video is in DOM
        if (rotation !== 0) {
          applyRotationTransform(vid, inner, rotation);
        }

        // Source toggle button (original / proxy) when rendered version exists
        if (result.video.renderedUrl) {
          const srcToggle = document.createElement('button');
          srcToggle.type = 'button';
          srcToggle.className = 'compare-slot__source-btn';
          srcToggle.title = preferProxy ? '当前：代理 — 点击切换为原画' : '当前：原画 — 点击切换为代理';
          srcToggle.textContent = preferProxy ? '代理' : '原画';
          srcToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextProxy = !result.video.useProxy;
            const wasPlaying = !vid.paused;
            const prevTime = vid.currentTime;
            vid.src = (nextProxy && result.video.renderedUrl) ? result.video.renderedUrl : result.video.url;
            vid.currentTime = prevTime;
            if (wasPlaying) vid.play().catch(() => {});
            srcToggle.textContent = nextProxy ? '代理' : '原画';
            srcToggle.title = nextProxy ? '当前：代理 — 点击切换为原画' : '当前：原画 — 点击切换为代理';
            result.video.useProxy = nextProxy;
            updateVideoMeta(result.video.id, { useProxy: nextProxy });
            // Re-apply rotation after source change (dimensions may differ)
            const rotAngle = parseInt(vid.getAttribute('data-rotation'));
            if (rotAngle) {
              vid.addEventListener('loadedmetadata', () => {
                applyRotationTransform(vid, inner, rotAngle);
              }, { once: true });
            }
            // Also refresh gallery cards if visible
            if (state.activeView === 'group') refreshCurrentView();
          });
          inner.appendChild(srcToggle);
        }

        // Video name overlay (visible only in fullscreen)
        const nameEl = document.createElement('span');
        nameEl.className = 'compare-slot__name';
        nameEl.textContent = result.video.title;
        slotEl.appendChild(nameEl);
      }
    } else {
      inner.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.2">
          <rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10,8 10,16 16,12"/>
        </svg>
        <p style="font-size:0.7rem;">选择视频</p>`;
    }

    // Individual fullscreen button (only when slot has video)
    if (videoId) {
      const fsBtn = document.createElement('button');
      fsBtn.className = 'compare-slot__fullscreen-btn';
      fsBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15,3 21,3 21,9"/>
          <polyline points="9,21 3,21 3,15"/>
          <line x1="21" y1="3" x2="14" y2="10"/>
          <line x1="3" y1="21" x2="10" y2="14"/>
        </svg>`;
      fsBtn.title = '全屏播放';
      fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const videoEl = inner.querySelector('video');
        if (videoEl) {
          if (videoEl.requestFullscreen) {
            videoEl.requestFullscreen();
          } else if (videoEl.webkitRequestFullscreen) {
            videoEl.webkitRequestFullscreen();
          }
        }
      });
      slotEl.appendChild(fsBtn);
    }

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'compare-slot__remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.compareSlots[i] = null;
      state.compareOffsets[i] = 0;
      const rmStore = state.compareGroupId ? state._compareByGroup[state.compareGroupId] : null;
      if (rmStore && rmStore.audioData) {
        rmStore.audioData[i] = null;
      }
      pauseAllCompareSlots();
      state.compareIsPlaying = false;
      clearAudioAlignment();
      renderCompareView();
    });

    slotEl.appendChild(inner);
    slotEl.appendChild(removeBtn);
    compareSlotsEl.appendChild(slotEl);
  }
}

function updateCompareMaster() {
  const hasAny = state.compareSlots.some(s => s !== null);
  compareMasterControl.style.display = hasAny ? 'block' : 'none';
  compareMasterPlayBtn.classList.remove('is-playing');
  compareMasterBtnLabel.textContent = '同步播放';
  state.compareIsPlaying = false;
}

compareMasterPlayBtn.addEventListener('click', () => {
  if (state.compareIsPlaying) {
    pauseCompareSlots();
  } else {
    // Set playing state IMMEDIATELY so the toggle responds instantly.
    // If play fails, playCompareSlots will revert the state.
    state.compareIsPlaying = true;
    compareMasterPlayBtn.classList.add('is-playing');
    compareMasterBtnLabel.textContent = '同步暂停';
    if (fullscreenPlayBtn) fullscreenPlayBtn.classList.add('is-playing');
    playCompareSlots();
  }
});

// --- Timeline Alignment Panel ---
const TIMELINE_LABEL_WIDTH = 150; // px — matches .timeline-panel__track-label width in CSS

const timelineView = {
  pxPerSec: 50,           // pixels per second of audio at 100%
  minPxPerSec: 5,
  maxPxPerSec: 500,
  scrollLeft: 0,          // horizontal scroll offset in pixels
  totalDuration: 0,       // longest video duration among filled slots
  commonEnd: 0,           // end of common timeline = max(duration + offset)
  draggingSlot: null,     // slot index being dragged, or null
  dragStartX: 0,
  dragStartOffset: 0,
  dragRangeHandle: null,  // 'start' | 'end' | null
};

/**
 * Get the stored audio data for a slot, or null.
 */
function getAudioDataForSlot(slotIdx) {
  const gid = state.compareGroupId;
  if (!gid || !state._compareByGroup[gid]) return null;
  const ad = state._compareByGroup[gid].audioData;
  if (!ad) return null;
  return ad[slotIdx] || null;
}

/**
 * Render the timeline panel: populate tracks, draw waveforms, range bar, ruler.
 */
function renderTimelinePanel() {
  if (!timelinePanel || !state.timelineVisible) {
    if (timelinePanel) timelinePanel.style.display = 'none';
    return;
  }
  timelinePanel.style.display = '';

  const gid = state.compareGroupId;
  const groupStore = gid ? state._compareByGroup[gid] : null;
  const audioData = groupStore ? groupStore.audioData : null;

  // Collect filled slots that are in the compare slots
  const filledSlots = [];
  for (let i = 0; i < COMPARE_SLOTS; i++) {
    if (state.compareSlots[i] !== null) {
      filledSlots.push({
        slotIdx: i,
        videoId: state.compareSlots[i],
        offset: state.compareOffsets[i] || 0,
        audio: audioData ? audioData[i] : null,
      });
    }
  }

  if (filledSlots.length < 1) {
    timelineTracks.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:0.7rem;">请先添加视频到对比槽位</div>';
    return;
  }

  // Determine total duration and offset range for common timeline
  let maxDuration = 0, maxOffset = 0;
  for (const s of filledSlots) {
    const result = findVideo(s.videoId);
    const dur = result?.video?.duration || 0;
    if (dur > maxDuration) maxDuration = dur;
    if (s.offset > maxOffset) maxOffset = s.offset;
  }
  if (maxDuration <= 0) maxDuration = 30;
  timelineView.totalDuration = maxDuration;
  // Common timeline spans from 0 to the end of the rightmost video
  const commonEnd = maxDuration + maxOffset;
  timelineView.commonEnd = commonEnd;

  // Auto-fit pxPerSec to show full common timeline
  const panelWidth = timelineScroll.clientWidth || 800;
  timelineView.pxPerSec = Math.max(
    timelineView.minPxPerSec,
    Math.min(timelineView.maxPxPerSec, panelWidth / commonEnd)
  );
  updateZoomLabel();

  const scrollWidth = TIMELINE_LABEL_WIDTH + commonEnd * timelineView.pxPerSec;

  // Size the range bar to match the scroll content timeline portion.
  // It lives inside the scroll area now, so its width and margin must
  // match the ruler / waveforms for percentage-based positioning to align.
  if (timelineRangeBar) {
    timelineRangeBar.style.width = (commonEnd * timelineView.pxPerSec) + 'px';
    timelineRangeBar.style.marginLeft = TIMELINE_LABEL_WIDTH + 'px';
    timelineRangeBar.style.marginBottom = '2px';
  }

  // Render tracks — each waveform canvas spans its own duration, positioned via translateX
  // translateX places the video's time=0 at TIMELINE_LABEL_WIDTH (aligned with ruler zero)
  let tracksHTML = '';
  for (const s of filledSlots) {
    const result = findVideo(s.videoId);
    const name = result?.video?.title || `槽位 ${s.slotIdx}`;
    const videoDur = result?.video?.duration || s.audio?.duration || 0;
    const waveWidth = videoDur * timelineView.pxPerSec;
    const offsetPx = s.offset * timelineView.pxPerSec;
    tracksHTML += `
      <div class="timeline-panel__track" data-slot="${s.slotIdx}">
        <span class="timeline-panel__track-label" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
        <div class="timeline-panel__track-wave-wrap" style="width:${scrollWidth}px;">
          <div class="timeline-panel__track-wave" data-slot="${s.slotIdx}"
               style="width:${waveWidth}px; transform:translateX(${TIMELINE_LABEL_WIDTH - offsetPx}px);">
            <canvas class="timeline-panel__track-canvas" data-slot="${s.slotIdx}"></canvas>
          </div>
        </div>
      </div>`;
  }
  timelineTracks.innerHTML = tracksHTML;

  // Draw waveforms on each canvas (deferred to next frame for DOM to settle)
  requestAnimationFrame(() => {
    for (const s of filledSlots) {
      const canvas = timelineTracks.querySelector(`.timeline-panel__track-canvas[data-slot="${s.slotIdx}"]`);
      if (canvas) drawWaveformOnCanvas(canvas, s);
    }
    drawRuler(commonEnd);
    drawRangeBar();
  });
}

/**
 * Draw a single waveform track on its canvas.
 */
function drawWaveformOnCanvas(canvas, slotInfo) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  // Full-width light-gray background — represents the video's entire duration,
  // so it's clear the bar spans the video, not just the extracted audio.
  ctx.fillStyle = 'rgba(200,200,200,0.10)';
  ctx.fillRect(0, 0, w, h);

  const audio = slotInfo.audio;
  if (!audio || audio.isSilent || !audio.energyEnvelope || audio.energyEnvelope.length === 0) {
    // Label "无音频" centred on the gray bar
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '0.6rem var(--font-mono)';
    ctx.textAlign = 'center';
    ctx.fillText('无音频数据', w / 2, h / 2 + 2);
    return;
  }

  const { energyEnvelope, envWindowRate } = audio;
  const { pxPerSec } = timelineView;

  // Find max energy for normalization
  let maxEnergy = 0;
  for (let i = 0; i < energyEnvelope.length; i++) {
    if (energyEnvelope[i] > maxEnergy) maxEnergy = energyEnvelope[i];
  }
  if (maxEnergy < 0.0001) maxEnergy = 0.0001;

  const windowPx = (1 / envWindowRate) * pxPerSec;

  // Draw waveform bars in amber on top of the gray background
  ctx.fillStyle = 'rgba(226, 176, 74, 0.5)';
  for (let j = 0; j < energyEnvelope.length; j++) {
    const t = j / envWindowRate;
    const x = t * pxPerSec;
    if (x > w + windowPx) break;

    const normEnergy = energyEnvelope[j] / maxEnergy;
    const barH = Math.max(1, normEnergy * (h * 0.8));
    const y = h - barH;
    ctx.fillRect(x, y, Math.max(1, windowPx - 0.5), barH);
  }

  // Subtle marker at the video's own time=0 (left edge of the bar)
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, h);
  ctx.stroke();
}

/**
 * Draw time ruler with tick marks.
 */
function drawRuler(totalDuration) {
  const canvas = timelineRuler;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const scrollWidth = TIMELINE_LABEL_WIDTH + totalDuration * timelineView.pxPerSec;
  const h = 18;
  canvas.width = scrollWidth * dpr;
  canvas.height = h * dpr;
  canvas.style.width = scrollWidth + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, scrollWidth, h);

  // Determine tick interval based on zoom
  const { pxPerSec } = timelineView;
  let tickInterval; // in seconds
  if (pxPerSec >= 200) tickInterval = 0.5;
  else if (pxPerSec >= 100) tickInterval = 1;
  else if (pxPerSec >= 40) tickInterval = 2;
  else if (pxPerSec >= 20) tickInterval = 5;
  else if (pxPerSec >= 10) tickInterval = 10;
  else tickInterval = 30;

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '0.52rem var(--font-mono)';
  ctx.textAlign = 'center';

  for (let t = 0; t <= totalDuration; t += tickInterval) {
    const x = TIMELINE_LABEL_WIDTH + t * pxPerSec;
    // Major tick
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, h - 8);
    ctx.lineTo(x, h);
    ctx.stroke();

    // Label
    ctx.fillText(formatTimelineTime(t), x, h - 10);
  }

  // Draw a subtle marker at time=0
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(TIMELINE_LABEL_WIDTH, 0);
  ctx.lineTo(TIMELINE_LABEL_WIDTH, h);
  ctx.stroke();
}

/**
 * Draw the range selection bar.
 */
function drawRangeBar() {
  const bar = timelineRangeBar;
  const sel = timelineRangeSelection;
  if (!bar || !sel) return;

  const gid = state.compareGroupId;
  const groupStore = gid ? state._compareByGroup[gid] : null;
  const commonStart = groupStore ? (groupStore.commonStart || 0) : 0;
  const commonDur = state.compareDuration || timelineView.commonEnd;

  const fullDur = timelineView.commonEnd || timelineView.totalDuration;
  if (fullDur <= 0) return;

  const startPct = (commonStart / fullDur) * 100;
  const endPct = ((commonStart + commonDur) / fullDur) * 100;

  sel.style.left = startPct + '%';
  sel.style.width = Math.max(0, endPct - startPct) + '%';
}

/**
 * Update the zoom percentage label.
 */
function updateZoomLabel() {
  if (!timelineZoomLabel) return;
  const { pxPerSec, totalDuration } = timelineView;
  const panelWidth = timelineScroll.clientWidth || 800;
  const fitPxPerSec = totalDuration > 0 ? panelWidth / totalDuration : 50;
  const pct = Math.round((pxPerSec / Math.max(1, fitPxPerSec)) * 100);
  timelineZoomLabel.textContent = pct + '%';
}

/**
 * Escape HTML entities for safe DOM insertion.
 */
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Format seconds as m:ss or mm:ss.
 */
function formatTimelineTime(secs) {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// --- Compare Fullscreen ---
let fullscreenExitBtn = null;
let fullscreenHint = null;
let fullscreenPlayBtn = null;
let fullscreenProgressBar = null;
let fullscreenProgressRAF = null;
let fullscreenDragSeek = false;

function getGridAspectRatio(filled) {
  // Columns, rows → aspect ratio = (cols * 16) / (rows * 9)
  // Based on adaptive grid from CSS data-filled rules
  if (filled <= 1) return 16 / 9;       // 1 col, 1 row
  if (filled <= 2) return 32 / 9;       // 2 cols, 1 row
  if (filled <= 4) return 16 / 9;       // 2 cols, 2 rows
  if (filled <= 6) return 8 / 3;        // 3 cols, 2 rows = 48/18
  return 32 / 9;                         // 4 cols, 2 rows = 64/18
}

function fitFullscreenGrid() {
  if (!viewCompare.classList.contains('compare--fullscreen')) return;
  const slotsEl = compareSlotsEl;
  const padding = 32; // 16px × 2
  const availW = window.innerWidth - padding;
  const availH = window.innerHeight - padding;

  const filled = state.compareSlots.filter(s => s !== null).length;
  const aspect = getGridAspectRatio(filled);

  // Determine constraining dimension: pick the one that maximizes size without overflow
  if (availW / aspect <= availH) {
    // Width-constrained: grid fills available width
    slotsEl.style.width = availW + 'px';
    slotsEl.style.height = Math.floor(availW / aspect) + 'px';
  } else {
    // Height-constrained: grid fills available height
    slotsEl.style.height = availH + 'px';
    slotsEl.style.width = Math.floor(availH * aspect) + 'px';
  }

  // Re-apply rotation transforms — containers changed size so rotated videos
  // need to recalculate their pixel dimensions for the new container size.
  slotsEl.querySelectorAll('.compare-slot__inner video[data-rotated]').forEach(video => {
    const inner = video.closest('.compare-slot__inner');
    const angle = parseInt(video.getAttribute('data-rotation'));
    if (inner && angle) {
      applyRotationTransform(video, inner, angle);
    }
  });
}

// ── Fullscreen progress bar helpers ──

function formatProgressTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Get the range-bar start offset (seconds on the common timeline). */
function getCommonStart() {
  const gid = state.compareGroupId;
  const groupStore = gid ? state._compareByGroup[gid] : null;
  return groupStore ? (groupStore.commonStart || 0) : 0;
}

/** Total duration shown on the progress bar (playback window). */
function getProgressDuration() {
  // When a playback window is defined (via alignment or range bar), use it
  if (state.compareDuration && state.compareDuration > 0) {
    return state.compareDuration;
  }
  const commonStart = getCommonStart();
  if (commonStart > 0 && timelineView.commonEnd > commonStart) {
    return timelineView.commonEnd - commonStart;
  }
  // Non-aligned: longest video duration
  let maxDur = 0;
  const slotEls = compareSlotsEl.querySelectorAll('.compare-slot.has-video');
  slotEls.forEach(slotEl => {
    const video = slotEl.querySelector('video');
    if (video && video.duration > maxDur) maxDur = video.duration;
  });
  return maxDur || 0;
}

/** Current position within the playback window (seconds). */
function getProgressPosition() {
  const commonStart = getCommonStart();
  // Use the first filled slot's video to read the common-timeline position
  const slotEls = compareSlotsEl.querySelectorAll('.compare-slot.has-video');
  for (const slotEl of slotEls) {
    const video = slotEl.querySelector('video');
    if (video && video.currentTime > 0) {
      const slotIdx = parseInt(slotEl.dataset.slot);
      const offset = state.compareOffsets[slotIdx] || 0;
      return Math.max(0, video.currentTime - offset - commonStart);
    }
  }
  return 0;
}

/** Seek all videos to a given position within the playback window. */
function seekAllToTimeline(targetSeconds) {
  // User manually chose a position — next play resumes from here
  _playbackEnded = false;

  const commonStart = getCommonStart();
  const hasOffsets = state.compareOffsets.some(o => o !== 0);

  const slotEls = compareSlotsEl.querySelectorAll('.compare-slot.has-video');
  slotEls.forEach(slotEl => {
    const video = slotEl.querySelector('video');
    if (!video) return;
    const slotIdx = parseInt(slotEl.dataset.slot);
    const offset = (hasOffsets || commonStart > 0) ? (state.compareOffsets[slotIdx] || 0) : 0;
    const seekTarget = offset + commonStart + targetSeconds;
    if (seekTarget >= 0 && seekTarget < (video.duration || Infinity)) {
      video.currentTime = seekTarget;
    }
  });
}

/** Update the progress bar fill, thumb, and time display. */
function updateProgressBarUI(fraction, forceVisible) {
  if (!fullscreenProgressBar) return;
  const fill = fullscreenProgressBar.querySelector('.compare__fullscreen-progress-fill');
  const thumb = fullscreenProgressBar.querySelector('.compare__fullscreen-progress-thumb');
  const currentEl = fullscreenProgressBar.querySelector('.compare__fullscreen-progress-current');
  const durationEl = fullscreenProgressBar.querySelector('.compare__fullscreen-progress-duration');

  const pct = Math.max(0, Math.min(100, fraction * 100));
  fill.style.width = pct + '%';
  thumb.style.left = pct + '%';

  const duration = getProgressDuration();
  currentEl.textContent = formatProgressTime(fraction * duration);
  durationEl.textContent = formatProgressTime(duration);

  if (forceVisible) {
    fullscreenProgressBar.classList.add('is-visible');
    clearTimeout(fullscreenProgressBar._hideTimer);
    fullscreenProgressBar._hideTimer = setTimeout(() => {
      fullscreenProgressBar.classList.remove('is-visible');
    }, 3000);
  }
}

/** Start the RAF loop that keeps the progress bar in sync during playback. */
function startProgressUpdates() {
  if (fullscreenProgressRAF) return;
  function tick() {
    if (!viewCompare.classList.contains('compare--fullscreen')) {
      fullscreenProgressRAF = null;
      return;
    }
    if (!fullscreenDragSeek) {
      const duration = getProgressDuration();
      if (duration > 0) {
        const pos = getProgressPosition();
        updateProgressBarUI(Math.min(1, pos / duration));
      }
    }
    fullscreenProgressRAF = requestAnimationFrame(tick);
  }
  fullscreenProgressRAF = requestAnimationFrame(tick);
}

function stopProgressUpdates() {
  if (fullscreenProgressRAF) {
    cancelAnimationFrame(fullscreenProgressRAF);
    fullscreenProgressRAF = null;
  }
}

function enterCompareFullscreen() {
  viewCompare.classList.add('compare--fullscreen');

  // Create floating exit button
  if (!fullscreenExitBtn) {
    fullscreenExitBtn = document.createElement('button');
    fullscreenExitBtn.className = 'compare__fullscreen-exit';
    fullscreenExitBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="4,10 4,4 10,4"/>
        <polyline points="20,14 20,20 14,20"/>
        <line x1="4" y1="4" x2="11" y2="11"/>
        <line x1="20" y1="20" x2="13" y2="13"/>
      </svg>
      退出全屏`;
    fullscreenExitBtn.addEventListener('click', exitCompareFullscreen);
    document.body.appendChild(fullscreenExitBtn);
  }
  fullscreenExitBtn.classList.remove('is-visible');
  // Show exit button briefly then fade
  setTimeout(() => fullscreenExitBtn.classList.add('is-visible'), 100);
  setTimeout(() => { if (viewCompare.classList.contains('compare--fullscreen')) fullscreenExitBtn.classList.remove('is-visible'); }, 4000);


	// Create floating play/pause button
	if (!fullscreenPlayBtn) {
		fullscreenPlayBtn = document.createElement('button');
		fullscreenPlayBtn.className = 'compare__fullscreen-play';
		fullscreenPlayBtn.innerHTML = `
		<svg class="play-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
		<svg class="pause-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="3" width="6" height="18"/><rect x="14" y="3" width="6" height="18"/></svg>`;
		fullscreenPlayBtn.addEventListener('click', toggleFullscreenPlay);
		document.body.appendChild(fullscreenPlayBtn);
	}
	fullscreenPlayBtn.classList.add('is-visible');
	syncFullscreenPlayBtn();

		// Create floating export button
		if (!fullscreenExportBtn) {
			fullscreenExportBtn = document.createElement('button');
			fullscreenExportBtn.className = 'compare__fullscreen-export';
			fullscreenExportBtn.innerHTML = `
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
					<polyline points="7,10 12,15 17,10"/>
					<line x1="12" y1="15" x2="12" y2="3"/>
				</svg>
				导出视频`;
			fullscreenExportBtn.addEventListener('click', openExportModal);
			document.body.appendChild(fullscreenExportBtn);
		}
		fullscreenExportBtn.classList.add('is-visible');

  // Show hint
  if (!fullscreenHint) {
    fullscreenHint = document.createElement('div');
    fullscreenHint.className = 'compare__fullscreen-hint';
    fullscreenHint.textContent = '按 Esc 或点击右上角退出全屏';
    document.body.appendChild(fullscreenHint);
  }
  fullscreenHint.classList.remove('fading');
  setTimeout(() => fullscreenHint.classList.add('fading'), 5000);

  btnFullscreen.textContent = '退出全屏';
  document.body.style.overflow = 'hidden';

  // --- Create progress bar ---
  if (!fullscreenProgressBar) {
    fullscreenProgressBar = document.createElement('div');
    fullscreenProgressBar.className = 'compare__fullscreen-progress';
    fullscreenProgressBar.innerHTML = `
      <div class="compare__fullscreen-progress-track">
        <div class="compare__fullscreen-progress-fill" style="width:0%"></div>
        <div class="compare__fullscreen-progress-thumb" style="left:0%"></div>
      </div>
      <div class="compare__fullscreen-progress-time">
        <span class="compare__fullscreen-progress-current">0:00</span>
        <span class="compare__fullscreen-progress-duration">0:00</span>
      </div>`;

    const track = fullscreenProgressBar.querySelector('.compare__fullscreen-progress-track');

    // Click on track → instant seek
    track.addEventListener('click', (e) => {
      const rect = track.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetTime = fraction * getProgressDuration();
      seekAllToTimeline(targetTime);
      updateProgressBarUI(fraction, true);
    });

    // Drag thumb → scrub
    const thumb = fullscreenProgressBar.querySelector('.compare__fullscreen-progress-thumb');
    const onDragStart = (e) => {
      fullscreenDragSeek = true;
      fullscreenProgressBar.classList.add('is-visible');
      e.preventDefault();
    };
    const onDragMove = (clientX) => {
      if (!fullscreenDragSeek) return;
      const rect = track.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      updateProgressBarUI(fraction, true);
    };
    const onDragEnd = (clientX) => {
      if (!fullscreenDragSeek) return;
      fullscreenDragSeek = false;
      const rect = track.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const targetTime = fraction * getProgressDuration();
      seekAllToTimeline(targetTime);
      updateProgressBarUI(fraction, true);
    };

    thumb.addEventListener('mousedown', onDragStart);
    track.addEventListener('mousedown', (e) => {
      // Only start drag if clicking on the track (not the fill)
      fullscreenDragSeek = true;
      fullscreenProgressBar.classList.add('is-visible');
    });
    document.addEventListener('mousemove', (e) => onDragMove(e.clientX));
    document.addEventListener('mouseup', (e) => { onDragEnd(e.clientX); });
    // Touch support
    thumb.addEventListener('touchstart', onDragStart);
    track.addEventListener('touchstart', (e) => {
      fullscreenDragSeek = true;
      fullscreenProgressBar.classList.add('is-visible');
    });
    document.addEventListener('touchmove', (e) => {
      if (fullscreenDragSeek) onDragMove(e.touches[0].clientX);
    }, { passive: false });
    document.addEventListener('touchend', (e) => {
      onDragEnd(e.changedTouches[0].clientX);
    });

    document.body.appendChild(fullscreenProgressBar);
  }

  // Show initial state
  updateProgressBarUI(0, true);
  startProgressUpdates();

  fitFullscreenGrid();
  window.addEventListener('resize', fitFullscreenGrid);
}

function exitCompareFullscreen() {
  // Stop any ongoing export recording
  if (exportRecording) stopExportRecording();

  // Pause all videos before layout change to prevent state corruption
  pauseCompareSlots();

  viewCompare.classList.remove('compare--fullscreen');
  if (fullscreenExitBtn) fullscreenExitBtn.remove();
  fullscreenExitBtn = null;
  if (fullscreenHint) fullscreenHint.remove();
  fullscreenHint = null;
	if (fullscreenPlayBtn) fullscreenPlayBtn.remove();
	fullscreenPlayBtn = null;
	if (fullscreenExportBtn) fullscreenExportBtn.remove();
	fullscreenExportBtn = null;
  stopProgressUpdates();
  if (fullscreenProgressBar) fullscreenProgressBar.remove();
  fullscreenProgressBar = null;
  fullscreenDragSeek = false;
  btnFullscreen.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="15,3 21,3 21,9"/>
      <polyline points="9,21 3,21 3,15"/>
      <line x1="21" y1="3" x2="14" y2="10"/>
      <line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
    全屏`;
  document.body.style.overflow = '';
  compareSlotsEl.style.width = '';
  compareSlotsEl.style.height = '';

  // Re-apply rotation transforms — exiting fullscreen reset the container
  // size, but rotated videos still have absolute positioning / dimensions
  // calculated for the fullscreen layout.  Without this they overflow the
  // normal-size slots and appear stuck in "enlarged" state.
  compareSlotsEl.querySelectorAll('.compare-slot__inner video[data-rotated]').forEach(video => {
    const inner = video.closest('.compare-slot__inner');
    const angle = parseInt(video.getAttribute('data-rotation'));
    if (inner && angle) {
      applyRotationTransform(video, inner, angle);
    }
  });

  window.removeEventListener('resize', fitFullscreenGrid);
}

btnFullscreen.addEventListener('click', () => {
  if (viewCompare.classList.contains('compare--fullscreen')) {
    exitCompareFullscreen();
  } else {
    enterCompareFullscreen();
  }
});

// --- Timeline Panel Event Handlers ---

// Toggle timeline panel visibility
btnTimelineToggle.addEventListener('click', () => {
  state.timelineVisible = !state.timelineVisible;
  if (state.timelineVisible) {
    renderTimelinePanel();
    startTimelinePlaybackCursor();
  } else {
    stopTimelinePlaybackCursor();
  }
  syncTimelineButton();
});

// Sync the timeline button visual state
function syncTimelineButton() {
  if (!btnTimelineToggle) return;
  if (state.timelineVisible) {
    btnTimelineToggle.classList.add('is-active');
  } else {
    btnTimelineToggle.classList.remove('is-active');
  }
}

// Zoom button delegation
timelinePanel.addEventListener('click', (e) => {
  const btn = e.target.closest('.timeline-panel__zoom-btn');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'zoom-in') {
    timelineView.pxPerSec = Math.min(timelineView.maxPxPerSec, timelineView.pxPerSec * 2);
  } else if (action === 'zoom-out') {
    timelineView.pxPerSec = Math.max(timelineView.minPxPerSec, timelineView.pxPerSec / 2);
  } else if (action === 'zoom-fit') {
    const panelWidth = timelineScroll.clientWidth || 800;
    const fullDur = timelineView.commonEnd || timelineView.totalDuration;
    timelineView.pxPerSec = Math.max(timelineView.minPxPerSec,
      Math.min(timelineView.maxPxPerSec, panelWidth / Math.max(1, fullDur)));
  }
  updateZoomLabel();
  renderTimelinePanel();
});

// Track dragging — pointer events delegation on tracks container.
// Dragging the waveform bar LEFT  → offset decreases (video starts earlier)
// Dragging the waveform bar RIGHT → offset increases (video starts later)
timelineTracks.addEventListener('pointerdown', (e) => {
  const trackWave = e.target.closest('.timeline-panel__track-wave');
  if (!trackWave) return;
  const track = trackWave.closest('.timeline-panel__track');
  if (!track) return;
  const slotIdx = parseInt(track.dataset.slot);
  if (isNaN(slotIdx)) return;

  timelineView.draggingSlot = slotIdx;
  timelineView.dragStartX = e.clientX;
  timelineView.dragStartOffset = state.compareOffsets[slotIdx] || 0;
  trackWave.style.transition = 'none';
  track.classList.add('dragging');
  trackWave.setPointerCapture(e.pointerId);
  e.preventDefault();
});

document.addEventListener('pointermove', (e) => {
  if (timelineView.draggingSlot === null) return;
  const slotIdx = timelineView.draggingSlot;
  const deltaPx = e.clientX - timelineView.dragStartX;
  const deltaSec = deltaPx / timelineView.pxPerSec;
  // translateX = -offset * pxPerSec
  // drag right → translateX更不负 → offset变小 → 视频从更早的时间开始播
  let newOffset = timelineView.dragStartOffset - deltaSec;

  const result = findVideo(state.compareSlots[slotIdx]);
  const videoDur = result?.video?.duration || 0;
  newOffset = Math.max(-videoDur, Math.min(3600, newOffset));
  newOffset = Math.round(newOffset * 100) / 100;

  if (state.compareOffsets[slotIdx] !== newOffset) {
    state.compareOffsets[slotIdx] = newOffset;
    // Update the waveform position in real-time via translateX
    const trackWave = timelineTracks.querySelector(`.timeline-panel__track-wave[data-slot="${slotIdx}"]`);
    if (trackWave) {
      trackWave.style.transform = `translateX(${TIMELINE_LABEL_WIDTH - newOffset * timelineView.pxPerSec}px)`;
    }
  }
});

document.addEventListener('pointerup', (e) => {
  if (timelineView.draggingSlot === null) return;
  const slotIdx = timelineView.draggingSlot;
  const track = timelineTracks.querySelector(`.timeline-panel__track[data-slot="${slotIdx}"]`);
  if (track) track.classList.remove('dragging');
  const trackWave = timelineTracks.querySelector(`.timeline-panel__track-wave[data-slot="${slotIdx}"]`);
  if (trackWave) {
    trackWave.style.transition = 'transform 0.15s ease-out';
  }
  timelineView.draggingSlot = null;
  persistCompareState(state.compareGroupId);
  // Full re-render to update ruler, range bar, other tracks
  renderTimelinePanel();
});

// Range handle dragging
timelineRangeBar.addEventListener('pointerdown', (e) => {
  e.stopPropagation(); // prevent click from bubbling to scroll area (which would seek)
  const barRect = timelineRangeBar.getBoundingClientRect();
  const clickPct = (e.clientX - barRect.left) / barRect.width;
  const gid = state.compareGroupId;
  const groupStore = gid ? state._compareByGroup[gid] : null;
  const fullDur = timelineView.commonEnd || timelineView.totalDuration;
  const commonStart = groupStore ? (groupStore.commonStart || 0) : 0;
  const commonDur = state.compareDuration || fullDur;

  const startPct = commonStart / fullDur;
  const endPct = (commonStart + commonDur) / fullDur;

  // Determine which handle is closer (within 3% of bar width)
  const distToStart = Math.abs(clickPct - startPct);
  const distToEnd = Math.abs(clickPct - endPct);

  if (distToStart < 0.03 || (distToStart < distToEnd && distToStart < 0.08)) {
    timelineView.dragRangeHandle = 'start';
  } else if (distToEnd < 0.03 || distToEnd < 0.08) {
    timelineView.dragRangeHandle = 'end';
  } else if (clickPct > startPct && clickPct < endPct) {
    // Click inside range — drag the whole range (move both handles)
    timelineView.dragRangeHandle = 'both';
    timelineView.dragStartX = clickPct;
    timelineView._dragRangeCommonStart = commonStart;
  }
  if (timelineView.dragRangeHandle) {
    timelineRangeBar.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});

document.addEventListener('pointermove', (e) => {
  if (!timelineView.dragRangeHandle) return;
  const barRect = timelineRangeBar.getBoundingClientRect();
  const clickPct = Math.max(0, Math.min(1, (e.clientX - barRect.left) / barRect.width));
  const fullDur = timelineView.commonEnd || timelineView.totalDuration;
  const clickTime = clickPct * fullDur;

  const gid = state.compareGroupId;
  const groupStore = gid ? state._compareByGroup[gid] : null;
  if (!groupStore) return;

  let commonStart = groupStore.commonStart || 0;
  let commonDur = state.compareDuration || fullDur;
  const commonEnd = commonStart + commonDur;

  if (timelineView.dragRangeHandle === 'start') {
    commonStart = Math.max(0, Math.min(commonEnd - 0.1, clickTime));
    groupStore.commonStart = Math.round(commonStart * 100) / 100;
  } else if (timelineView.dragRangeHandle === 'end') {
    const newEnd = Math.max(commonStart + 0.1, clickTime);
    commonDur = newEnd - commonStart;
    state.compareDuration = Math.round(commonDur * 100) / 100;
  } else if (timelineView.dragRangeHandle === 'both') {
    const deltaPct = clickPct - timelineView.dragStartX;
    const deltaSec = deltaPct * fullDur;
    const newStart = timelineView._dragRangeCommonStart + deltaSec;
    commonStart = Math.max(0, newStart);
    groupStore.commonStart = Math.round(commonStart * 100) / 100;
  }

  drawRangeBar();
});

document.addEventListener('pointerup', () => {
  if (timelineView.dragRangeHandle) {
    persistCompareState(state.compareGroupId);
    timelineView.dragRangeHandle = null;
    // Apply to offsets: add commonStart as uniform shift
    applyRangeToOffsets();
  }
});

/**
 * Apply the range start as a uniform shift to all offsets.
 * This ensures playback starts at the range start boundary.
 */
function applyRangeToOffsets() {
  // The range start is a global shift; we handle this during playback by
  // reading commonStart alongside compareOffsets. No need to mutate offsets.
  drawRangeBar();
}

// Sync scroll between ruler canvas and tracks
timelineScroll.addEventListener('scroll', () => {
  timelineView.scrollLeft = timelineScroll.scrollLeft;
});

// --- Timeline playback cursor ---
let timelineCursorRAF = null;
let cursorDragActive = false;

function startTimelinePlaybackCursor() {
  if (timelineCursorRAF) return;
  function tick() {
    if (!state.timelineVisible || !timelinePanel || timelinePanel.style.display === 'none') {
      stopTimelinePlaybackCursor();
      return;
    }
    if (!cursorDragActive) {
      updateTimelineCursor();
    }
    timelineCursorRAF = requestAnimationFrame(tick);
  }
  timelineCursorRAF = requestAnimationFrame(tick);
}

function stopTimelinePlaybackCursor() {
  if (timelineCursorRAF) {
    cancelAnimationFrame(timelineCursorRAF);
    timelineCursorRAF = null;
  }
  if (timelineCursor) timelineCursor.style.display = 'none';
}

/**
 * Return the current common-timeline position in seconds.
 * Uses the first video that has valid currentTime.
 */
function getTimelinePosition() {
  const slotEls = compareSlotsEl.querySelectorAll('.compare-slot.has-video');
  for (const slotEl of slotEls) {
    const video = slotEl.querySelector('video');
    if (video && video.duration > 0) {
      const slotIdx = parseInt(slotEl.dataset.slot);
      const offset = state.compareOffsets[slotIdx] || 0;
      return video.currentTime - offset;
    }
  }
  return -1;
}

function updateTimelineCursor() {
  if (!timelineCursor) return;
  const pos = getTimelinePosition();
  if (pos < 0) {
    timelineCursor.style.display = 'none';
    return;
  }

  const cursorPx = TIMELINE_LABEL_WIDTH + pos * timelineView.pxPerSec;
  timelineCursor.style.display = 'block';
  timelineCursor.style.left = cursorPx + 'px';
  // Show time label
  const timeLabel = timelineCursor.querySelector('.timeline-panel__cursor-time');
  if (timeLabel) timeLabel.textContent = formatTimelineTime(pos);
}

/**
 * Seek all videos to a common-timeline time.
 */
function seekTimelineTo(commonTime) {
  // User manually dragged cursor / clicked timeline — resume from here
  _playbackEnded = false;

  commonTime = Math.max(0, commonTime);
  const slotEls = compareSlotsEl.querySelectorAll('.compare-slot.has-video');
  for (const slotEl of slotEls) {
    const video = slotEl.querySelector('video');
    if (video && video.duration > 0) {
      const slotIdx = parseInt(slotEl.dataset.slot);
      const offset = state.compareOffsets[slotIdx] || 0;
      const target = Math.max(0, Math.min(video.duration, offset + commonTime));
      video.currentTime = target;
    }
  }
  updateTimelineCursor();
}

// Cursor drag
if (timelineCursor) {
  timelineCursor.addEventListener('pointerdown', (e) => {
    cursorDragActive = true;
    timelineCursor.classList.add('dragging');
    timelineCursor.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
}

// Click on scroll area (ruler or tracks) to seek
timelineScroll.addEventListener('pointerdown', (e) => {
  // Don't interfere with track dragging
  if (timelineView.draggingSlot !== null) return;
  if (e.target.closest('.timeline-panel__track-wave')) return;

  const scrollRect = timelineScroll.getBoundingClientRect();
  const clickX = e.clientX - scrollRect.left + timelineView.scrollLeft - TIMELINE_LABEL_WIDTH;
  const commonTime = clickX / timelineView.pxPerSec;
  seekTimelineTo(commonTime);

  // Also start cursor drag for continuous scrubbing
  cursorDragActive = true;
  timelineCursor.classList.add('dragging');
  timelineCursor.setPointerCapture(e.pointerId);
  e.preventDefault();
});

// Cursor and scroll-area drag move
document.addEventListener('pointermove', (e) => {
  if (!cursorDragActive) return;
  const scrollRect = timelineScroll.getBoundingClientRect();
  const dragX = e.clientX - scrollRect.left + timelineView.scrollLeft - TIMELINE_LABEL_WIDTH;
  const commonTime = Math.max(0, dragX / timelineView.pxPerSec);
  seekTimelineTo(commonTime);
});

document.addEventListener('pointerup', () => {
  if (cursorDragActive) {
    cursorDragActive = false;
    timelineCursor.classList.remove('dragging');
  }
});

// Escape key to exit fullscreen
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewCompare.classList.contains('compare--fullscreen')) {
    exitCompareFullscreen();
  }
});


// Toggle play/pause in fullscreen mode
function toggleFullscreenPlay() {
  if (state.compareIsPlaying) {
    pauseCompareSlots();
  } else {
    // Set playing state IMMEDIATELY so the toggle responds instantly
    state.compareIsPlaying = true;
    compareMasterPlayBtn.classList.add('is-playing');
    compareMasterBtnLabel.textContent = '同步暂停';
    if (fullscreenPlayBtn) fullscreenPlayBtn.classList.add('is-playing');
    playCompareSlots();
  }
}

// Sync fullscreen play button state
function syncFullscreenPlayBtn() {
  if (state.compareIsPlaying) {
    fullscreenPlayBtn.classList.add('is-playing');
  } else {
    fullscreenPlayBtn.classList.remove('is-playing');
  }
}

// ============================================
// Fullscreen Export (Canvas + MediaRecorder)
// ============================================
let fullscreenExportBtn = null;
let exportRecorder = null;
let exportRecording = false;
let exportProgressEl = null;
let _exportProgressDone = false;

// DOM refs for export modal
const exportModalOverlay = $('#exportModalOverlay');
const exportModalConfirm = $('#exportModalConfirm');
const exportModalCancel = $('#exportModalCancel');
const exportResolution = $('#exportResolution');
const exportFramerate = $('#exportFramerate');
const exportCustomRow = $('#exportCustomRow');
const exportCustomWidth = $('#exportCustomWidth');
const exportCustomHeight = $('#exportCustomHeight');
const exportFpsCustomRow = $('#exportFpsCustomRow');
const exportCustomFps = $('#exportCustomFps');
const exportFormat = $('#exportFormat');
const exportFormatHint = $('#exportFormatHint');
const exportShowNames = $('#exportShowNames');
const exportModeButtons = $$('#exportModeSwitch .mode-switch__btn');
const exportCompositeOptions = $('#exportCompositeOptions');
const exportIndividualInfo = $('#exportIndividualInfo');
const exportIndividualCount = $('#exportIndividualCount');

let exportMode = 'composite'; // 'composite' | 'individual'

function getGridLayout(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  return { cols: 4, rows: 2 };
}

function openExportModal() {
  // Detect best format
  const mp4Supported = MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
  const webmSupported = MediaRecorder.isTypeSupported('video/webm; codecs="vp9"');

  if (mp4Supported) {
    exportFormat.value = 'mp4';
    exportFormatHint.textContent = '当前浏览器支持 MP4 格式';
  } else if (webmSupported) {
    exportFormat.value = 'webm';
    exportFormatHint.textContent = '当前浏览器仅支持 WebM，可用 FFmpeg 转为 MP4';
  } else {
    exportFormat.value = 'webm';
    exportFormatHint.textContent = '浏览器不支持 MP4 编码，将导出 WebM';
  }

  // Detect native resolution from source videos
  exportResolution.value = 'auto';
  const autoRes = getExportResolution();
  const hasAlignment = state.compareOffsets && state.compareOffsets.some(o => o !== 0);
  exportResolution.querySelector('option[value="auto"]').textContent =
    `原始分辨率（自动 — ${autoRes.w}×${autoRes.h}）${hasAlignment ? ' · 已对齐' : ''}`;
  exportCustomRow.style.display = 'none';
  exportFpsCustomRow.style.display = 'none';

  exportFramerate.value = 'auto';

  // Count individual export videos
  const filledCount = state.compareSlots.filter(s => s !== null).length;
  exportIndividualCount.textContent = filledCount > 0 ? `${filledCount} 个视频` : '单独导出';

  // Reset to composite mode
  setExportMode('composite');

  exportModalOverlay.style.display = 'flex';
}

function closeExportModal() {
  exportModalOverlay.style.display = 'none';
}

// Export mode switcher
function setExportMode(mode) {
  exportMode = mode;
  exportModeButtons.forEach(btn => {
    btn.classList.toggle('mode-switch__btn--active', btn.dataset.mode === mode);
  });
  if (mode === 'composite') {
    exportCompositeOptions.style.display = '';
    exportIndividualInfo.style.display = 'none';
    exportModalConfirm.textContent = '开始导出';
  } else {
    exportCompositeOptions.style.display = 'none';
    exportIndividualInfo.style.display = '';
    exportModalConfirm.textContent = '全部导出';
  }
}

exportModeButtons.forEach(btn => {
  btn.addEventListener('click', () => setExportMode(btn.dataset.mode));
});

exportResolution.addEventListener('change', () => {
  const showCustom = exportResolution.value === 'custom';
  exportCustomRow.style.display = showCustom ? 'grid' : 'none';
});

exportFramerate.addEventListener('change', () => {
  const showCustom = exportFramerate.value === 'custom';
  exportFpsCustomRow.style.display = showCustom ? 'grid' : 'none';
});

exportModalCancel.addEventListener('click', closeExportModal);
exportModalOverlay.addEventListener('click', (e) => {
  if (e.target === exportModalOverlay) closeExportModal();
});

function getExportResolution() {
  const val = exportResolution.value;
  switch (val) {
    case '1080p': return { w: 1920, h: 1080 };
    case '720p': return { w: 1280, h: 720 };
    case '4k': return { w: 3840, h: 2160 };
    case 'custom': return {
      w: parseInt(exportCustomWidth.value) || 1920,
      h: parseInt(exportCustomHeight.value) || 1080,
    };
    default: { // auto — calculate from source video native resolutions
      const slotEls = compareSlotsEl.querySelectorAll('.compare-slot.has-video');
      const layout = getGridLayout(slotEls.length);
      let maxW = 320, maxH = 240;
      slotEls.forEach(slotEl => {
        const video = slotEl.querySelector('video');
        if (video && video.videoWidth) {
          maxW = Math.max(maxW, video.videoWidth);
          maxH = Math.max(maxH, video.videoHeight);
        }
      });
      // Canvas = grid cells × max per-cell dimension
      return { w: maxW * layout.cols, h: maxH * layout.rows };
    }
  }
}

function getExportFramerate() {
  const val = exportFramerate.value;
  switch (val) {
    case '24': return 24;
    case '30': return 30;
    case '60': return 60;
    case 'custom': return parseInt(exportCustomFps.value) || 30;
    default: { // auto — detect from first video
      const filled = state.compareSlots.filter(s => s !== null);
      for (const vidId of filled) {
        const result = findVideo(vidId);
        if (result) {
          const slotEl = compareSlotsEl.querySelector(`.compare-slot[data-slot]`);
          if (slotEl) {
            const video = slotEl.querySelector('video');
            if (video && video.readyState >= 2) return 30; // default fallback
          }
        }
      }
      // Try to detect from stored metadata
      for (const vidId of filled) {
        const result = findVideo(vidId);
        if (result && result.video.fps && result.video.fps > 0) {
          return Math.round(result.video.fps);
        }
      }
      return 30;
    }
  }
}

async function startExportRecording() {
  const resolution = getExportResolution();
  const fps = getExportFramerate();
  const format = exportFormat.value;

  // Get active videos
  const filled = state.compareSlots.filter(s => s !== null);
  if (filled.length === 0) {
    showToast('没有可导出的视频', 'error');
    return;
  }

  const videos = [];
  const videoTitles = []; // parallel array of video titles
  const rotations = [];   // parallel array of rotation angles (0, 90, 180, 270)
  const slotIndices = []; // parallel array: which slot (0-7) each video occupies
  const slotEls = compareSlotsEl.querySelectorAll('.compare-slot.has-video');
  slotEls.forEach(slotEl => {
    const video = slotEl.querySelector('video');
    if (video) {
      videos.push(video);
      // Resolve title and rotation from compare slot video ID
      const slotIdx = parseInt(slotEl.dataset.slot);
      slotIndices.push(slotIdx);
      const videoId = state.compareSlots[slotIdx];
      if (videoId) {
        const result = findVideo(videoId);
        videoTitles.push(result ? result.video.title : '');
        rotations.push(result ? (result.video.rotation || 0) : 0);
      } else {
        videoTitles.push('');
        rotations.push(0);
      }
    }
  });

  if (videos.length === 0) {
    showToast('没有找到视频元素', 'error');
    return;
  }

  const showNames = exportShowNames.checked;

  closeExportModal();

  // Determine MIME type
  let mimeType;
  if (format === 'mp4' && MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E"')) {
    mimeType = 'video/mp4; codecs="avc1.42E01E"';
  } else if (MediaRecorder.isTypeSupported('video/webm; codecs="vp9"')) {
    mimeType = 'video/webm; codecs="vp9"';
  } else if (MediaRecorder.isTypeSupported('video/webm; codecs="vp8"')) {
    mimeType = 'video/webm; codecs="vp8"';
  } else {
    mimeType = 'video/webm';
  }

  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';

  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.width = resolution.w;
  canvas.height = resolution.h;
  const ctx = canvas.getContext('2d');

  // Grid layout
  const layout = getGridLayout(videos.length);
  const cellW = canvas.width / layout.cols;
  const cellH = canvas.height / layout.rows;

  // Draw a single composite frame
  function drawFrame() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      if (video.readyState < 2) continue;

      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      const x = col * cellW;
      const y = row * cellH;
      const rotation = rotations[i] || 0;

      // Effective dimensions after rotation (90°/270° swap width & height visually)
      const vw = video.videoWidth || resolution.w;
      const vh = video.videoHeight || resolution.h;
      const isRotated90 = rotation === 90 || rotation === 270;
      const effW = isRotated90 ? vh : vw;
      const effH = isRotated90 ? vw : vh;
      const scale = Math.min(cellW / effW, cellH / effH);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = x + (cellW - dw) / 2;
      const dy = y + (cellH - dh) / 2;
      const cx = x + cellW / 2;
      const cy = y + cellH / 2;

      // Apply rotation transform if needed (match the CSS rotation in compare view)
      if (rotation !== 0) {
        ctx.save();
        ctx.translate(cx, cy);
        if (rotation === 90) ctx.rotate(Math.PI / 2);
        else if (rotation === 180) ctx.rotate(Math.PI);
        else if (rotation === 270) ctx.rotate(-Math.PI / 2);
        ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
      } else {
        ctx.drawImage(video, dx, dy, dw, dh);
      }

      // Draw video name in bottom-right corner if enabled
      if (showNames && videoTitles[i]) {
        const title = videoTitles[i];
        // Calculate font size proportional to cell height
        const fontSize = Math.max(12, Math.min(28, cellH * 0.055));
        ctx.save();
        ctx.font = `600 ${fontSize}px "Noto Serif SC", "PingFang SC", sans-serif`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';

        // Semi-transparent background behind text for readability
        const metrics = ctx.measureText(title);
        const textW = metrics.width;
        const textH = fontSize * 1.3;
        const padX = fontSize * 0.5;
        const padY = fontSize * 0.25;
        const bgX = x + cellW - textW - padX * 2;
        const bgY = y + cellH - textH - padY * 2;
        const bgW = textW + padX * 2;
        const bgH = textH + padY * 2;

        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.roundRect(bgX, bgY, bgW, bgH, 4);
        ctx.fill();

        // Draw text shadow for depth
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 4;
        ctx.fillText(title, x + cellW - padX, y + cellH - padY);
        ctx.restore();
      }
    }
  }

  // Start MediaRecorder
  const stream = canvas.captureStream(fps);
  // Auto-calculate bitrate based on resolution: ~0.15 bpp, clamp 5–50 Mbps
  const autoBitrate = Math.max(5000000, Math.min(50000000, Math.round(resolution.w * resolution.h * fps * 0.15)));
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: autoBitrate,
  });
  exportRecorder = recorder;

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `compare_${resolution.w}x${resolution.h}_${ts}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`导出完成：${resolution.w}×${resolution.h} ${fps}fps .${ext}`);
    // Keep the "done" state visible briefly before cleanup
    setTimeout(() => cleanupExport(), 2500);
  };

  recorder.onerror = () => {
    showToast('导出失败', 'error');
    cleanupExport();
  };

  // Animation loop to feed frames + track progress
  let animId;
  const frameInterval = 1000 / fps;
  let lastFrameTime = 0;

  // Find the longest effective duration for progress tracking
  const offsets = state.compareOffsets || [];
  const hasAlignment = state.compareDuration && state.compareDuration > 0
    && offsets.some(o => o !== 0);
  let maxEndTime = 0;
  if (hasAlignment) {
    // Aligned: all videos play from their offset for commonDuration
    videos.forEach((v, i) => {
      const offset = offsets[slotIndices[i]] || 0;
      const dur = v.duration || 0;
      const endTime = Math.min(offset + state.compareDuration, dur || Infinity);
      if (endTime > maxEndTime) maxEndTime = endTime;
    });
  } else {
    videos.forEach((v) => {
      const dur = v.duration || 0;
      if (dur > maxEndTime) maxEndTime = dur;
    });
  }
  // If we couldn't determine duration, fall back to a reasonable estimate
  if (!maxEndTime || !isFinite(maxEndTime)) maxEndTime = 30;

  // Track real elapsed time for aligned export stop
  // (will be set when playback actually starts after seek + play)
  let playbackStartTime = 0;
  const alignedStopTime = hasAlignment ? state.compareDuration * 1000 : null;

  // Determine whether all videos have ended
  function allEnded() {
    return videos.every(v => v.ended || (v.paused && v.currentTime >= (v.duration || 0) - 0.15));
  }

  function animLoop(timestamp) {
    if (!exportRecording) return;
    if (timestamp - lastFrameTime >= frameInterval) {
      drawFrame();
      lastFrameTime = timestamp;
    }
    // Track progress
    const elapsed = timestamp - playbackStartTime;
    if (alignedStopTime && elapsed >= alignedStopTime) {
      // Aligned export: stop after commonDuration
      exportRecording = false;
      if (exportRecorder && exportRecorder.state === 'recording') {
        exportRecorder.stop();
      }
      updateExportProgress(100);
      showExportDone();
      return;
    }
    if (maxEndTime > 0) {
      const pct = alignedStopTime
        ? Math.min(100, (elapsed / alignedStopTime) * 100)
        : (videos.length > 0 ? (Math.max(...videos.map(v => v.currentTime || 0)) / maxEndTime) * 100 : 0);
      updateExportProgress(pct);
    }
    // Auto-stop when all videos have finished (non-aligned export fallback)
    if (!alignedStopTime && allEnded()) {
      exportRecording = false;
      if (exportRecorder && exportRecorder.state === 'recording') {
        exportRecorder.stop();
      }
      showExportDone();
      return;
    }
    animId = requestAnimationFrame(animLoop);
  }

  // Seek all videos to aligned start positions (use seeked event for precision)
  await Promise.all(videos.map(async (v, i) => {
    const offset = offsets[slotIndices[i]] || 0;
    const targetTime = Math.max(0, offset);
    if (targetTime > 0 && targetTime < (v.duration || Infinity)) {
      await new Promise((resolve) => {
        const onSeeked = () => {
          v.removeEventListener('seeked', onSeeked);
          resolve();
        };
        v.addEventListener('seeked', onSeeked);
        v.currentTime = targetTime;
        // Safety timeout in case seeked never fires
        setTimeout(() => {
          v.removeEventListener('seeked', onSeeked);
          resolve();
        }, 5000);
      });
    }
    v.muted = true;
  }));

  exportRecording = true;
  recorder.start(100); // collect data every 100ms

  // Play all videos
  try {
    await Promise.all(videos.map(v => v.play()));
  } catch (e) {
    // autoplay might be blocked
  }

  // Capture start time after playback has actually begun
  playbackStartTime = performance.now();

  animId = requestAnimationFrame(animLoop);

  // Show export progress panel
  showExportProgress();

  // Store cleanup refs
  exportRecorder._cleanupRefs = { canvas, stream, chunks, animId, videos };
}

function showExportProgress() {
  if (exportProgressEl) return;
  _exportProgressDone = false;
  exportProgressEl = document.createElement('div');
  exportProgressEl.className = 'compare__export-progress';
  exportProgressEl.innerHTML = `
    <div class="compare__export-progress-header">
      <span class="compare__export-progress-label">
        <span class="compare__export-progress-spinner"></span>
        正在导出视频…
      </span>
      <span class="compare__export-progress-pct">0%</span>
    </div>
    <div class="compare__export-progress-track">
      <div class="compare__export-progress-fill" id="exportProgressFill"></div>
    </div>
    <button class="compare__export-stop" id="exportStopBtn">取消导出</button>
  `;
  document.body.appendChild(exportProgressEl);
  exportProgressEl.querySelector('#exportStopBtn').addEventListener('click', stopExportRecording);
}

function updateExportProgress(pct) {
  if (!exportProgressEl || _exportProgressDone) return;
  const fill = exportProgressEl.querySelector('#exportProgressFill');
  const pctEl = exportProgressEl.querySelector('.compare__export-progress-pct');
  if (fill) fill.style.width = Math.min(100, Math.round(pct)) + '%';
  if (pctEl) pctEl.textContent = Math.min(100, Math.round(pct)) + '%';
}

function showExportDone() {
  if (!exportProgressEl || _exportProgressDone) return;
  _exportProgressDone = true;
  exportProgressEl.classList.add('compare__export-progress--done');
  const label = exportProgressEl.querySelector('.compare__export-progress-label');
  if (label) label.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:#5b8c5a">
      <polyline points="20,6 9,17 4,12"/>
    </svg>
    导出完成
  `;
  updateExportProgress(100);
  const stopBtn = exportProgressEl.querySelector('#exportStopBtn');
  if (stopBtn) stopBtn.remove();
  // Auto-dismiss after 2 seconds
  setTimeout(() => hideExportProgress(), 2000);
}

function hideExportProgress() {
  if (exportProgressEl) {
    exportProgressEl.remove();
    exportProgressEl = null;
  }
  _exportProgressDone = false;
}

function stopExportRecording() {
  if (!exportRecording || !exportRecorder) return;
  exportRecording = false;
  if (exportRecorder.state === 'recording') exportRecorder.stop();

  // Pause videos
  const refs = exportRecorder._cleanupRefs;
  if (refs && refs.videos) {
    refs.videos.forEach(v => v.pause());
  }
  if (refs && refs.animId) {
    cancelAnimationFrame(refs.animId);
  }

  hideExportProgress();
}

function cleanupExport() {
  const refs = exportRecorder ? exportRecorder._cleanupRefs : null;
  if (refs) {
    if (refs.animId) cancelAnimationFrame(refs.animId);
    if (refs.stream) refs.stream.getTracks().forEach(t => t.stop());
  }
  exportRecorder = null;
  exportRecording = false;
  hideExportProgress();
}

// --- Trim & encode a single video segment (used for aligned individual export) ---
// Records [startSec, startSec+durationSec] at original resolution with high bitrate.
// rotation: 0, 90, 180, or 270 — applied to canvas drawing to match the rotated preview.
async function trimAndDownloadVideo(videoUrl, startSec, durationSec, title, rotation = 0) {
  const video = document.createElement('video');
  video.src = videoUrl;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;

  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', reject, { once: true });
  });

  // Use original resolution
  let w = video.videoWidth;
  let h = video.videoHeight;
  if (!w || !h || w === 0 || h === 0) {
    w = 1920; h = 1080;
  }
  // Ensure even dimensions
  w = w % 2 === 0 ? w : w + 1;
  h = h % 2 === 0 ? h : h + 1;

  // Detect native frame rate
  let fps = 30;
  const hasVFC = 'requestVideoFrameCallback' in video;
  if (hasVFC) {
    video.currentTime = Math.max(0, startSec);
    await new Promise((resolve) => {
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
      video.addEventListener('seeked', onSeeked);
      // Safety timeout
      setTimeout(() => { video.removeEventListener('seeked', onSeeked); resolve(); }, 5000);
    });
    await video.play();
    let frameCount = 0;
    const detectStart = performance.now();
    await new Promise((resolve) => {
      const onFrame = () => {
        frameCount++;
        if (performance.now() - detectStart >= 600) { resolve(); return; }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    });
    const elapsed = (performance.now() - detectStart) / 1000;
    if (elapsed > 0 && frameCount > 0) {
      fps = Math.max(10, Math.min(60, Math.round(frameCount / elapsed)));
    }
    video.pause();
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(fps);
  // Try MP4 first (better compatibility), then webm
  let mimeType;
  if (MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E"')) {
    mimeType = 'video/mp4; codecs="avc1.42E01E"';
  } else if (MediaRecorder.isTypeSupported('video/webm; codecs=vp9')) {
    mimeType = 'video/webm; codecs=vp9';
  } else if (MediaRecorder.isTypeSupported('video/webm; codecs=vp8')) {
    mimeType = 'video/webm; codecs=vp8';
  } else {
    mimeType = 'video/webm';
  }

  // High bitrate for quality: scale based on resolution area
  const area = w * h;
  const bitrate = Math.max(8000000, Math.min(80000000, Math.round(area * fps * 0.3)));

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  // Seek to start position (precise, using seeked event)
  video.currentTime = Math.max(0, startSec);
  await new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    setTimeout(() => { video.removeEventListener('seeked', onSeeked); resolve(); }, 5000);
  });

  recorder.start(100);
  await video.play();

  // Draw loop — stop after durationSec
  const startTime = performance.now();
  const targetMs = durationSec * 1000;

  // For rotated videos, swap canvas dimensions to match visual output
  const hasSwapRotation = rotation === 90 || rotation === 270;
  if (hasSwapRotation && canvas.width > 0 && canvas.height > 0) {
    canvas.width = h;
    canvas.height = w;
  }

  await new Promise((resolve) => {
    const drawLoop = () => {
      if (video.ended || performance.now() - startTime >= targetMs) {
        if (recorder.state === 'recording') recorder.stop();
        resolve();
        return;
      }
      if (video.readyState >= 2) {
        if (rotation !== 0) {
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          if (rotation === 90) ctx.rotate(Math.PI / 2);
          else if (rotation === 180) ctx.rotate(Math.PI);
          else if (rotation === 270) ctx.rotate(-Math.PI / 2);
          // For 90/270, canvas was already swapped, so w/h are visually correct
          ctx.drawImage(video, -w / 2, -h / 2, w, h);
          ctx.restore();
        } else {
          ctx.drawImage(video, 0, 0, w, h);
        }
      }
      requestAnimationFrame(drawLoop);
    };
    requestAnimationFrame(drawLoop);
  });

  // Ensure recorder is stopped
  if (recorder.state === 'recording') {
    await new Promise(r => setTimeout(r, 200));
    if (recorder.state === 'recording') recorder.stop();
  }

  // Wait for final data
  await new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });

  video.pause();
  video.src = '';
  stream.getTracks().forEach(t => t.stop());

  if (chunks.length === 0) return null;

  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const safeName = (title || 'video').replace(/[\\/:*?"<>|]/g, '_').trim() || 'video';
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName + '.' + ext;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay to ensure download starts
  setTimeout(() => URL.revokeObjectURL(url), 3000);

  return blob;
}

// --- Individual video export ---
async function startIndividualExport() {
  const filled = state.compareSlots
    .map((videoId, i) => ({ videoId, slotIdx: i }))
    .filter(s => s.videoId !== null);

  if (filled.length === 0) {
    showToast('没有可导出的视频', 'error');
    return;
  }

  closeExportModal();
  showExportProgress();

  // Check if alignment is active
  const offsets = state.compareOffsets || [];
  const hasAlignment = state.compareDuration && state.compareDuration > 0
    && offsets.some(o => o !== 0);
  const commonDuration = hasAlignment ? state.compareDuration : null;

  let completed = 0;
  const total = filled.length;

  for (const slot of filled) {
    const result = findVideo(slot.videoId);
    if (!result) { completed++; continue; }

    const video = result.video;
    updateExportProgress(Math.round((completed / total) * 100));

    if (hasAlignment && commonDuration && commonDuration > 0) {
      // Trimmed export — re-encode at original resolution
      const offset = offsets[slot.slotIdx] || 0;
      updateExportProgress(Math.round((completed / total) * 100));
      // Update progress label to show current video
      if (exportProgressEl) {
        const label = exportProgressEl.querySelector('.compare__export-progress-label');
        if (label) {
          const spinner = label.querySelector('.compare__export-progress-spinner');
          label.textContent = '';
          if (spinner) label.appendChild(spinner);
          label.appendChild(document.createTextNode(` 正在导出 (${completed + 1}/${total}): ${video.title}`));
        }
      }
      await trimAndDownloadVideo(video.url, offset, commonDuration, video.title, video.rotation || 0);
    } else {
      // No alignment — download original blob as-is, preserving original format
      if (exportProgressEl) {
        const label = exportProgressEl.querySelector('.compare__export-progress-label');
        if (label) {
          const spinner = label.querySelector('.compare__export-progress-spinner');
          label.textContent = '';
          if (spinner) label.appendChild(spinner);
          label.appendChild(document.createTextNode(` 正在导出 (${completed + 1}/${total}): ${video.title}`));
        }
      }
      const safeName = (video.title || 'video').replace(/[\\/:*?"<>|]/g, '_').trim() || 'video';
      // Preserve original file extension
      const origExt = (video.originalName || '').split('.').pop().toLowerCase();
      const ext = origExt && origExt.length <= 5 ? '.' + origExt : '.mp4';
      const a = document.createElement('a');
      a.href = video.url;
      a.download = safeName + ext;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Small delay between downloads
      await new Promise(r => setTimeout(r, 400));
    }

    completed++;
  }

  updateExportProgress(100);
  showExportDone();
  const msg = hasAlignment
    ? `已导出 ${completed} 个对齐裁剪后的视频`
    : `已导出 ${completed} 个视频（原始画质）`;
  showToast(msg, 'success');
}

exportModalConfirm.addEventListener('click', () => {
  if (exportMode === 'individual') {
    startIndividualExport();
  } else {
    startExportRecording();
  }
});

let _comparePlaybackTimer = null;
let _playbackEnded = true; // true when playback hasn't started or has run to completion
let _staggerTimers = [];    // individual video start-delay timeouts (staggered playback)

/**
 * Wait for a video to be ready to seek (metadata loaded) and seek to a position.
 * Returns a promise that resolves when the seek completes.
 */
function waitForReadyAndSeek(video, targetTime) {
  return new Promise((resolve) => {
    // If video is already near the target, resolve immediately
    if (Math.abs(video.currentTime - targetTime) < 0.05) {
      resolve();
      return;
    }

    let seeked = false;
    const onSeeked = () => {
      seeked = true;
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };

    // Safety timeout: resolve after 5s even if seeked never fires
    const timeout = setTimeout(() => {
      if (!seeked) {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      }
    }, 5000);

    video.addEventListener('seeked', onSeeked);

    // If the video isn't ready to seek yet, wait for metadata first
    if (video.readyState < 1) {
      video.addEventListener('loadedmetadata', () => {
        if (!seeked) video.currentTime = targetTime;
      }, { once: true });
    } else {
      video.currentTime = targetTime;
    }
  });
}

async function playCompareSlots() {
  const slots = compareSlotsEl.querySelectorAll('.compare-slot');
  const offsets = state.compareOffsets;
  const commonDur = state.compareDuration;
  const commonStart = getCommonStart();
  const hasOffsets = offsets.some(o => o !== 0) || commonDur !== null || commonStart > 0;

  // Clear any previous end-of-playback timer
  if (_comparePlaybackTimer) { clearTimeout(_comparePlaybackTimer); _comparePlaybackTimer = null; }

  // --- Step 1: gather videos and seek to aligned positions ---
  // Only seek when starting from scratch (first play or playback ended).
  // When resuming from a user-initiated pause, keep the current position.
  const videos = [];
  const seekPromises = [];
  const shouldSeek = _playbackEnded;
  _playbackEnded = false;

  if (shouldSeek) {
    slots.forEach((slot, i) => {
      const video = slot.querySelector('video');
      if (!video) return;
      videos.push(video);

      // Ensure video is loadable — if src is broken, skip with warning
      if (video.readyState === 0 && video.networkState === 3) {
        // networkState 3 = NETWORK_NO_SOURCE — video has no/invalid source
        console.warn(`[Compare] 槽位 ${i}: 视频未加载，跳过`);
        return;
      }

      const startTime = hasOffsets ? Math.max(0, (offsets[i] || 0) + commonStart) : commonStart;
      if (startTime > 0 && startTime < (video.duration || Infinity)) {
        console.log(`[Compare] 槽位 ${i}: seek 到 ${startTime.toFixed(2)}s (偏移=${offsets[i]?.toFixed(2) || 0}s, commonStart=${commonStart.toFixed(2)}s)`);
        seekPromises.push(waitForReadyAndSeek(video, startTime));
      } else {
        console.log(`[Compare] 槽位 ${i}: 从头播放 (startTime=${startTime}, duration=${video.duration})`);
      }
    });
  } else {
    // Resuming from pause — just collect video references, no seeking
    slots.forEach((slot, i) => {
      const video = slot.querySelector('video');
      if (!video) return;
      videos.push(video);
      if (video.readyState === 0 && video.networkState === 3) {
        console.warn(`[Compare] 槽位 ${i}: 视频未加载，跳过`);
        return;
      }
    });
  }

  // No loadable videos at all — revert state immediately
  if (videos.length === 0) {
    console.warn('[Compare] 无可播放的视频，取消');
    pauseCompareSlots();
    return;
  }

  // Wait for all seeks to complete before playing
  if (seekPromises.length > 0) {
    console.log(`[Compare] 等待 ${seekPromises.length} 个视频 seek 到位…`);
    await Promise.all(seekPromises);
    // Verify seeks and retry if needed
    slots.forEach((slot, i) => {
      const video = slot.querySelector('video');
      if (!video) return;
      const targetTime = hasOffsets ? Math.max(0, (offsets[i] || 0) + commonStart) : commonStart;
      const actualTime = video.currentTime;
      if (targetTime > 0) {
        const errMs = Math.abs(actualTime - targetTime) * 1000;
        console.log(`[Compare] 槽位 ${i} seek 验证: 目标=${targetTime.toFixed(2)}s, 实际=${actualTime.toFixed(2)}s, 误差=${errMs.toFixed(0)}ms`);
        // Retry seek if it landed far off (> 500ms error)
        if (errMs > 500) {
          console.warn(`[Compare] 槽位 ${i}: seek 偏差过大 (${errMs.toFixed(0)}ms)，重试…`);
          video.currentTime = targetTime;
        }
      }
    });
    console.log('[Compare] 所有 seek 完成，同步播放');
  }

  // --- Step 2: ensure videos are playable ---
  // Wait up to 3s for each video to have enough data buffered
  await Promise.all(videos.map(async (video, idx) => {
    if (video.readyState >= 2) return; // HAVE_CURRENT_DATA or better
    // Wait for canplay or timeout
    let resolved = false;
    await new Promise(resolve => {
      const onReady = () => { if (!resolved) { resolved = true; resolve(); } };
      video.addEventListener('canplay', onReady, { once: true });
      video.addEventListener('loadeddata', onReady, { once: true });
      setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 3000);
    });
  }));

  // --- Step 3: play all videos simultaneously, with retry ---
  let playResults = await Promise.allSettled(
    videos.map(video => video.play())
  );

  // Retry failed videos once after a brief delay (decoder may need more time)
  const retryIndices = [];
  playResults.forEach((r, idx) => {
    if (r.status === 'rejected') {
      retryIndices.push(idx);
      console.warn(`[Compare] 槽位 ${idx} 首次播放失败:`, r.reason?.message);
    }
  });

  if (retryIndices.length > 0) {
    await new Promise(r => setTimeout(r, 200));
    const retryResults = await Promise.allSettled(
      retryIndices.map(idx => videos[idx].play())
    );
    retryResults.forEach((r, ri) => {
      const idx = retryIndices[ri];
      playResults[idx] = r; // replace original result
      if (r.status === 'rejected') {
        console.warn(`[Compare] 槽位 ${idx} 重试仍然失败:`, r.reason?.message);
      } else {
        console.log(`[Compare] 槽位 ${idx} 重试成功`);
      }
    });
  }

  const started = playResults.some(r => r.status === 'fulfilled');

  // --- Step 4: schedule auto-pause ---
  if (commonDur && commonDur > 0 && started) {
    _comparePlaybackTimer = setTimeout(() => {
      _playbackEnded = true; // playback ran to completion — next play restarts from beginning
      pauseCompareSlots();
      _comparePlaybackTimer = null;
    }, commonDur * 1000);
  }

  if (started) {
    // State was already set by the click handler — just sync fullscreen button
    if (fullscreenPlayBtn) fullscreenPlayBtn.classList.add('is-playing');
  } else {
    // All videos failed to play — revert the optimistic state
    console.warn('[Compare] 所有视频播放失败，回退播放状态');
    pauseCompareSlots();
  }
}

function pauseCompareSlots() {
  if (_comparePlaybackTimer) { clearTimeout(_comparePlaybackTimer); _comparePlaybackTimer = null; }
  _staggerTimers.forEach(t => clearTimeout(t));
  _staggerTimers = [];
  const slots = compareSlotsEl.querySelectorAll('.compare-slot');
  slots.forEach(slot => { const v = slot.querySelector('video'); if (v) v.pause(); });
  state.compareIsPlaying = false;
  compareMasterPlayBtn.classList.remove('is-playing');
  compareMasterBtnLabel.textContent = '同步播放';
  if (fullscreenPlayBtn) fullscreenPlayBtn.classList.remove('is-playing');
}

function pauseAllCompareSlots() {
  if (_comparePlaybackTimer) { clearTimeout(_comparePlaybackTimer); _comparePlaybackTimer = null; }
  _staggerTimers.forEach(t => clearTimeout(t));
  _staggerTimers = [];
  const slots = compareSlotsEl.querySelectorAll('.compare-slot');
  slots.forEach(slot => {
    const v = slot.querySelector('video');
    if (v) { v.pause(); v.remove(); }
  });
  // Video elements are destroyed — next play must be a fresh start with seeking.
  _playbackEnded = true;
}

// ============================================
// Video Card (shared)
// ============================================
function createVideoCard(videoItem, index) {
  const card = document.createElement('article');
  card.className = 'video-card';
  card.style.animationDelay = `${index * 0.05}s`;

  const player = document.createElement('div');
  player.className = 'video-card__player';

  // Choose source: proxy or original
  function getVideoSource(item) {
    return (item.useProxy && item.renderedUrl) ? item.renderedUrl : item.url;
  }

  const video = document.createElement('video');
  video.src = getVideoSource(videoItem);
  video.preload = 'metadata';
  video.playsInline = true;

  const playingDot = document.createElement('span');
  playingDot.className = 'video-card__playing-dot';

  const overlay = document.createElement('div');
  overlay.className = 'video-card__overlay';
  overlay.innerHTML = `<span class="video-card__overlay-icon"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg></span>`;

  player.appendChild(video);
  player.appendChild(playingDot);
  player.appendChild(overlay);

  videoItem._playing = false;
  function setPlaying(s) {
    videoItem._playing = s;
    if (s) { player.classList.add('playing'); player.classList.remove('paused'); }
    else { player.classList.remove('playing'); player.classList.add('paused'); }
    updateGroupMasterBtnState();
  }

  video.addEventListener('play', () => setPlaying(true));
  video.addEventListener('pause', () => setPlaying(false));
  video.addEventListener('ended', () => setPlaying(false));
  video.addEventListener('loadedmetadata', () => { player.classList.add('paused'); });

  player.addEventListener('click', () => {
    if (video.paused || video.ended) { video.currentTime = 0; video.play().catch(() => {}); }
    else { video.pause(); }
  });

  const body = document.createElement('div');
  body.className = 'video-card__body';
  // Rotation applied as data attribute on card
  card.setAttribute('data-rotation', videoItem.rotation || 0);

  const resText = formatResolution(videoItem.width, videoItem.height);
  const durText = formatDuration(videoItem.duration);
  const fpsText = videoItem.fps ? `${videoItem.fps}fps` : null;
  const sizeText = videoItem.fileSize ? formatSize(videoItem.fileSize) : null;
  const specsEntries = [resText, fpsText, durText, sizeText].filter(Boolean);
  const specsHTML = specsEntries.length > 0
    ? `<div class="video-card__specs">${specsEntries.map(s => `<span>${s}</span>`).join('')}</div>`
    : '';

  const hasProxy = !!videoItem.renderedUrl;
  const sourceToggleHTML = hasProxy ? `
    <div class="video-card__source">
      <button type="button" class="video-card__source-btn${videoItem.useProxy ? '' : ' is-active'}" data-source="original">原画</button>
      <button type="button" class="video-card__source-btn${videoItem.useProxy ? ' is-active' : ''}" data-source="proxy">代理</button>
    </div>` : '';

  body.innerHTML = `
    <h3 class="video-card__title">${escapeHtml(videoItem.title)}</h3>
    <p class="video-card__desc">${escapeHtml(videoItem.description || '暂无注记')}</p>
    ${specsHTML}
    ${sourceToggleHTML}
    <div class="video-card__meta">
      <span class="video-card__time">${new Date(videoItem.addedAt).toLocaleString('zh-CN', { year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' })}</span>
      <button type="button" class="video-card__rotate" title="旋转90°">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1,4 1,1 4,1"/><path d="M1,12 A11,11 0 0,1 23,12"/><polyline points="23,20 23,23 20,23"/><path d="M23,12 A11,11 0 0,1 1,12"/></svg>
      </button>
      <button type="button" class="video-card__remove">移除</button>
    </div>`;

  // Rotate button: cycle 0 → 90 → 180 → 270 → 0
  const rotateBtn = body.querySelector('.video-card__rotate');
  rotateBtn.setAttribute('data-rotation', videoItem.rotation || 0);
  // Apply initial rotation transform
  if (videoItem.rotation) {
    applyRotationTransform(video, player, videoItem.rotation);
  }
  rotateBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = ((videoItem.rotation || 0) + 90) % 360;
    videoItem.rotation = next;
    card.setAttribute('data-rotation', next);
    rotateBtn.setAttribute('data-rotation', next);
    applyRotationTransform(video, player, next);
    await updateVideoMeta(videoItem.id, { rotation: next });
    // Update compare view if this video is in a slot
    if (state.compareSlots.includes(videoItem.id)) {
      renderCompareView();
    }
  });

  body.querySelector('.video-card__remove').addEventListener('click', async (e) => {
    e.stopPropagation();
    card.style.transition = 'all 0.3s cubic-bezier(0.4,0,0.2,1)';
    card.style.transform = 'scale(0.95)';
    card.style.opacity = '0';
    card.addEventListener('transitionend', async () => {
      URL.revokeObjectURL(videoItem.url);
      if (videoItem.renderedUrl) URL.revokeObjectURL(videoItem.renderedUrl);
      const group = findGroup(videoItem.groupId);
      if (group) {
        group.videos = group.videos.filter(v => v.id !== videoItem.id);
      }
      // Remove from all groups' compare slots
      Object.values(state._compareByGroup).forEach(data => {
        data.slots = data.slots.map(s => s === videoItem.id ? null : s);
      });
      await deleteVideoFromDB(videoItem.id);
      showToast('已移除', 'error');
      refreshCurrentView();
    }, { once: true });
  });

  // Source toggle: switch between original and proxy
  if (hasProxy) {
    const sourceBtns = body.querySelectorAll('.video-card__source-btn');
    sourceBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const useProxy = btn.dataset.source === 'proxy';
        if (useProxy === videoItem.useProxy) return;

        // Remember playback state
        const wasPlaying = !video.paused;
        const prevTime = video.currentTime;

        // Switch source
        video.src = getVideoSource({ ...videoItem, useProxy });
        video.currentTime = prevTime;
        if (wasPlaying) video.play().catch(() => {});

        // Update active states
        sourceBtns.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');

        // Persist preference
        videoItem.useProxy = useProxy;
        updateVideoMeta(videoItem.id, { useProxy });

        // Re-apply rotation after source change (dimensions may differ)
        const rotAngle = parseInt(video.getAttribute('data-rotation'));
        if (rotAngle) {
          video.addEventListener('loadedmetadata', () => {
            applyRotationTransform(video, player, rotAngle);
          }, { once: true });
        }
      });
    });
  }

  // Inline-edit for video title
  const titleEl = body.querySelector('.video-card__title');
  makeEditable(titleEl, {
    type: 'input',
    cssClass: 'inline-edit--title',
    onSave: async (v) => {
      videoItem.title = v;
      await updateVideoMeta(videoItem.id, { title: v });
      // Update compare view if this video is in a compare slot
      if (state.activeView === 'compare') renderCompareView();
    }
  });

  // Inline-edit for video description
  const descEl = body.querySelector('.video-card__desc');
  makeEditable(descEl, {
    type: 'textarea',
    cssClass: 'inline-edit--desc',
    emptyText: '暂无注记',
    onSave: async (v) => {
      videoItem.description = v;
      await updateVideoMeta(videoItem.id, { description: v });
    }
  });

  // --- Drag video into sub-group ---
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    if (card._editing) { e.preventDefault(); return; }
    card.classList.add('is-dragging');
    e.dataTransfer.setData('text/plain', 'video:' + videoItem.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('is-dragging');
  });

  card.appendChild(player);
  card.appendChild(body);
  cardVideoMap.set(card, video);
  return card;
}

function updateGroupMasterBtnState() {
  const group = findGroup(state.activeGroupId);
  if (!group) return;
  const pageVids = getGroupPageVideos(group);
  const anyPlaying = pageVids.some(v => v._playing);
  const allPlaying = pageVids.length > 0 && pageVids.every(v => v._playing);

  if (allPlaying) {
    state.groupIsPlaying = true;
    groupMasterPlayBtn.classList.add('is-playing');
    groupMasterBtnLabel.textContent = '全部暂停';
  } else if (!anyPlaying) {
    state.groupIsPlaying = false;
    groupMasterPlayBtn.classList.remove('is-playing');
    groupMasterBtnLabel.textContent = '全部播放';
  }
}

function playCards(container) {
  const cards = container.querySelectorAll('.video-card:not(.video-card--empty)');
  cards.forEach(card => {
    const v = cardVideoMap.get(card);
    if (v) { const p = v.play(); if (p) p.catch(() => {}); }
  });
}

function pauseCards(container) {
  const cards = container.querySelectorAll('.video-card:not(.video-card--empty)');
  cards.forEach(card => {
    const v = cardVideoMap.get(card);
    if (v) v.pause();
  });
}

function pauseAllInView() {
  pauseCards(groupGallery);
  pauseAllCompareSlots();
  state.groupIsPlaying = false;
  state.compareIsPlaying = false;
}

function refreshCurrentView() {
  if (state.activeView === 'groups') navigate('groups');
  else if (state.activeView === 'group') navigate('group', state.activeGroupId);
  else if (state.activeView === 'compare') navigate('compare');
}

// ============================================
// Upload Form
// ============================================
// Track selected files for multi-file upload
let selectedFiles = [];

function handleFiles(files) {
  if (!files || files.length === 0) return;

  // Filter to video files only
  const videoFiles = Array.from(files).filter(f => f.type.startsWith('video/'));
  if (videoFiles.length === 0) {
    showToast('请选择视频文件格式', 'error');
    return;
  }

  if (videoFiles.length < files.length) {
    showToast(`已跳过 ${files.length - videoFiles.length} 个非视频文件`, 'error');
  }

  selectedFiles = videoFiles;

  // Update preview display
  if (videoFiles.length === 1) {
    fileName.textContent = videoFiles[0].name;
    fileSize.textContent = formatSize(videoFiles[0].size);
  } else {
    const totalSize = videoFiles.reduce((s, f) => s + f.size, 0);
    fileName.textContent = `已选择 ${videoFiles.length} 个视频文件`;
    fileSize.textContent = `共 ${formatSize(totalSize)}`;
  }
  filePreview.style.display = 'flex';

  // Auto-fill title from first file's name (always update on file selection)
  const nameWithoutExt = videoFiles[0].name.replace(/\.[^.]+$/, '');
  videoTitle.value = videoFiles.length === 1 ? nameWithoutExt : '';
}

function clearFile() {
  videoFile.value = '';
  selectedFiles = [];
  fileName.textContent = '';
  fileSize.textContent = '';
  filePreview.style.display = 'none';
}

videoFile.addEventListener('change', () => handleFiles(videoFile.files));
fileClearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearFile(); });

fileDropZone.addEventListener('dragover', (e) => { e.preventDefault(); fileDropZone.classList.add('drag-over'); });
fileDropZone.addEventListener('dragleave', () => { fileDropZone.classList.remove('drag-over'); });
fileDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) {
    const dt = new DataTransfer();
    Array.from(e.dataTransfer.files).forEach(f => dt.items.add(f));
    videoFile.files = dt.files;
    handleFiles(dt.files);
  }
});

// Upload form submit — adds multiple videos to current group
videoForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (selectedFiles.length === 0) {
    showToast('请先选择视频文件', 'error');
    return;
  }

  const group = findGroup(state.activeGroupId);
  if (!group) { showToast('分组不存在', 'error'); return; }

  const userTitle = videoTitle.value.trim();
  const userDesc = videoDesc.value.trim();
  let added = 0;

  for (const file of selectedFiles) {
    // Each video gets its own title from filename, or user's custom title
    const filenameTitle = file.name.replace(/\.[^.]+$/, '');
    const title = selectedFiles.length === 1 && userTitle
      ? userTitle
      : filenameTitle;

    const url = URL.createObjectURL(file);

    // Extract video metadata (resolution, duration, frame rate)
    let metadata = { width: null, height: null, duration: null, fps: null };
    try {
      metadata = await extractVideoMetadata(file, url);
    } catch {
      // If metadata extraction fails, proceed without it
    }

    const videoItem = {
      id: generateId(),
      title: title || '未命名视频',
      description: userDesc,
      url,
      addedAt: Date.now(),
      groupId: group.id,
      rotation: 0,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      fps: metadata.fps,
      useProxy: false,
      fileSize: file.size,
      fileType: file.type || '',
      originalName: file.name || '',
    };

    // Persist video blob to IndexedDB
    await persistVideo(videoItem, file);
    group.videos.unshift(videoItem);
    added++;
  }

  showToast(`已添加 ${added} 个视频至「${group.name}」`);

  videoForm.reset();
  clearFile();
  // Collapse the form after successful upload
  videoForm.classList.remove('form--expanded');
  videoForm.classList.add('form--collapsed');
  btnAddVideo.style.display = 'flex';
  refreshCurrentView();
});

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatResolution(w, h) {
  if (!w || !h) return null;
  return `${w}×${h}`;
}

async function extractVideoMetadata(file, url) {
  const video = document.createElement('video');
  video.src = url;
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;

  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', reject, { once: true });
  });

  const result = {
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    fps: null,
  };

  // Detect frame rate via requestVideoFrameCallback (~500ms playback)
  if ('requestVideoFrameCallback' in video && isFinite(video.duration) && video.duration > 0) {
    try {
      video.currentTime = 0;
      await video.play();
      let frameCount = 0;
      const start = performance.now();
      await new Promise((resolve) => {
        const onFrame = () => {
          frameCount++;
          if (performance.now() - start >= 500) {
            resolve();
            return;
          }
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      });
      const elapsed = (performance.now() - start) / 1000;
      result.fps = Math.round(frameCount / elapsed);
      result.fps = Math.max(10, Math.min(60, result.fps));
      video.pause();
    } catch {
      // Frame rate detection failed — leave as null
    }
  }

  // Clean up temp element without revoking blob URL (still used by the video item)
  video.removeAttribute('src');
  video.load();
  video.remove();

  return result;
}

async function backfillVideoMetadata() {
  // Collect videos missing any metadata field
  const needsBackfill = [];
  for (const group of state.groups) {
    for (const video of group.videos) {
      if (!video.width || !video.height || !video.duration || !video.fps) {
        needsBackfill.push(video);
      }
    }
  }

  if (needsBackfill.length === 0) return;
  console.log(`[FilmArchive] Backfilling metadata for ${needsBackfill.length} videos...`);

  for (const video of needsBackfill) {
    if (!video.url) continue;

    const tmp = document.createElement('video');
    tmp.src = video.url;
    tmp.preload = 'metadata';
    tmp.muted = true;
    tmp.playsInline = true;

    try {
      await new Promise((resolve, reject) => {
        tmp.addEventListener('loadedmetadata', resolve, { once: true });
        tmp.addEventListener('error', reject, { once: true });
      });

      // Fill in resolution + duration (instant from headers)
      if (!video.width) video.width = tmp.videoWidth;
      if (!video.height) video.height = tmp.videoHeight;
      if (!video.duration) video.duration = tmp.duration;

      // Detect FPS if still missing
      if (!video.fps && 'requestVideoFrameCallback' in tmp && isFinite(tmp.duration) && tmp.duration > 0) {
        try {
          tmp.currentTime = Math.min(1, tmp.duration / 4);
          await tmp.play();
          let frameCount = 0;
          const start = performance.now();
          await new Promise((resolve) => {
            const onFrame = () => {
              frameCount++;
              if (performance.now() - start >= 500) {
                resolve();
                return;
              }
              tmp.requestVideoFrameCallback(onFrame);
            };
            tmp.requestVideoFrameCallback(onFrame);
          });
          const elapsed = (performance.now() - start) / 1000;
          video.fps = Math.round(frameCount / elapsed);
          video.fps = Math.max(10, Math.min(60, video.fps));
          tmp.pause();
        } catch {
          // FPS detection failed
        }
      }

      // Persist updated metadata to IndexedDB
      await updateVideoMeta(video.id, {
        width: video.width,
        height: video.height,
        duration: video.duration,
        fps: video.fps,
      });
    } catch {
      console.warn(`[FilmArchive] Could not extract metadata for: ${video.title}`);
    } finally {
      tmp.removeAttribute('src');
      tmp.load();
      tmp.remove();
    }
  }

  console.log('[FilmArchive] Metadata backfill complete — refreshing view');
  refreshCurrentView();
}

// --- Video rotation (with dynamic scale for proper fit) ---
function applyRotationTransform(videoEl, containerEl, angle) {
  if (!videoEl || !containerEl) return;

  // Reset all rotation styles
  videoEl.style.transform = '';
  videoEl.style.transformOrigin = '';
  videoEl.style.width = '';
  videoEl.style.height = '';
  videoEl.style.position = '';
  videoEl.style.top = '';
  videoEl.style.left = '';
  videoEl.style.marginTop = '';
  videoEl.style.marginLeft = '';
  videoEl.style.objectFit = '';

  if (angle === 0) {
    videoEl.removeAttribute('data-rotated');
    videoEl.removeAttribute('data-rotation');
    return;
  }

  if (angle === 180) {
    videoEl.style.transform = 'rotate(180deg)';
    videoEl.removeAttribute('data-rotated'); // 180° fits normally
    videoEl.setAttribute('data-rotation', '180');
    return;
  }

  // 90° or 270°: size element so that after rotation it fills the container as much
  // as possible without cropping, using black bars where needed.
  videoEl.setAttribute('data-rotated', 'true');
  videoEl.setAttribute('data-rotation', angle);

  const calcAndApply = () => {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    const cw = containerEl.clientWidth;
    const ch = containerEl.clientHeight;

    if (!vw || !vh || !cw || !ch) return;

    // After 90°/270° rotation, the visual dimensions swap: vh wide × vw tall.
    // Scale so the rotated video fits entirely within the container.
    const scale = Math.min(cw / vh, ch / vw);
    const elW = Math.round(vw * scale);
    const elH = Math.round(vh * scale);

    // Size and center the video element; rotate only.
    videoEl.style.width = elW + 'px';
    videoEl.style.height = elH + 'px';
    videoEl.style.position = 'absolute';
    videoEl.style.top = '50%';
    videoEl.style.left = '50%';
    videoEl.style.marginTop = Math.round(-elH / 2) + 'px';
    videoEl.style.marginLeft = Math.round(-elW / 2) + 'px';
    videoEl.style.objectFit = 'fill'; // fill the sized element, no extra scaling
    videoEl.style.transform = `rotate(${angle}deg)`;
    videoEl.style.transformOrigin = 'center center';
  };

  if (videoEl.videoWidth && videoEl.videoHeight) {
    calcAndApply();
  } else {
    // Metadata not ready yet — defer
    videoEl.addEventListener('loadedmetadata', calcAndApply, { once: true });
    // Temporary rotation until dimensions are known
    videoEl.style.transform = `rotate(${angle}deg)`;
    videoEl.style.transformOrigin = 'center center';
  }
}

// Inline editing helper
function makeEditable(el, options) {
  if (!el) return;

  // Use text cursor for text-editable fields, default for name fields
  el.style.cursor = options.type === 'textarea' ? 'text' : 'default';
  el.title = '双击编辑';

  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (el._editing) return;
    el._editing = true;

    const originalText = el.textContent;
    const isTextarea = options.type === 'textarea';
    const input = document.createElement(isTextarea ? 'textarea' : 'input');
    input.value = originalText === '暂无注记' || originalText === '暂无描述' ? '' : originalText;
    input.className = 'inline-edit ' + (options.cssClass || '');
    if (!isTextarea) input.type = 'text';

    el.replaceWith(input);
    input.focus();
    input.select();

    const restore = (newDisplayText) => {
      if (newDisplayText !== undefined) {
        el.textContent = newDisplayText;
      }
      input.replaceWith(el);
      el._editing = false;
    };

    const save = async () => {
      const rawValue = input.value.trim();
      // For textarea, allow empty; for input, require non-empty
      if (isTextarea) {
        if (rawValue !== originalText && rawValue !== (originalText === '暂无注记' ? '' : originalText)) {
          try {
            await options.onSave(rawValue);
            restore(rawValue || (options.emptyText || '暂无注记'));
            return;
          } catch (err) { /* fall through to restore */ }
        }
        restore();
      } else {
        if (rawValue && rawValue !== originalText) {
          try {
            await options.onSave(rawValue);
            restore(rawValue);
            return;
          } catch (err) { /* fall through to restore */ }
        }
        restore();
      }
    };

    const cancel = () => restore();

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter' && !(isTextarea && ke.shiftKey)) {
        ke.preventDefault();
        input.blur(); // triggers save via blur
      }
      if (ke.key === 'Escape') { ke.preventDefault(); cancel(); }
    });
  });
}

// ---- Inline-edit bindings for group detail ----
if (groupDetailName) {
  makeEditable(groupDetailName, {
    type: 'input',
    cssClass: 'inline-edit--group-name',
    onSave: async (v) => {
      const group = findGroup(state.activeGroupId);
      if (!group) return;
      group.name = v;
      await persistGroup(group);
      navBreadcrumb.textContent = v;
      showToast('分组已重命名');
    }
  });
}

if (groupDetailDesc) {
  makeEditable(groupDetailDesc, {
    type: 'textarea',
    cssClass: 'inline-edit--group-desc',
    emptyText: '暂无描述',
    onSave: async (v) => {
      const group = findGroup(state.activeGroupId);
      if (!group) return;
      group.description = v;
      await persistGroup(group);
    }
  });
}

// ---- Inline-edit bindings for compare slot names ----
// These elements are recreated each render, so bindings happen in renderCompareSlots

// ============================================
// Initialize (with persistence)
// ============================================
async function init() {
  console.log('[FilmArchive] 正在加载数据...');
  console.log('[FilmArchive] DB名称:', DB_NAME, '版本:', DB_VERSION);
  await loadAllData();

  console.log('[FilmArchive] 加载完成:', state.groups.length, '个分组,',
    state.groups.reduce((s, g) => s + g.videos.length, 0), '个视频');

  // Create default group if empty
  if (state.groups.length === 0) {
    console.log('[FilmArchive] 数据为空，创建默认分组');
    const defaultGroup = {
      id: generateId(),
      name: '默认分组',
      description: '默认分组',
      color: GROUP_COLORS[0],
      videos: [],
    };
    colorIdx++;
    state.groups.push(defaultGroup);
    await persistGroup(defaultGroup);
  }

  navigate('groups');
  videoTitle.focus();

  // Backfill metadata for existing videos in the background (runs after UI renders)
  backfillVideoMetadata().catch(err => {
    console.warn('[FilmArchive] Metadata backfill error:', err);
  });
}

init().catch(err => {
  console.error('[FilmArchive] 初始化失败:', err);
  showToast('数据加载失败，请刷新页面重试', 'error');
});

// ---- Auto-test: run alignment via URL parameter ----
// Append ?test=GROUP_NAME to the URL to auto-run alignment after page load.
// e.g. file:///.../index.html?test=夕阳拍摄
(async function autoTestFromURL() {
  const params = new URLSearchParams(window.location.search);
  const testGroup = params.get('test') || params.get('autotest');
  if (!testGroup) return;

  console.log(`[AutoTest] URL 参数指定测试分组: "${testGroup}"`);
  console.log('[AutoTest] 等待页面初始化完成 (2s) …');
  await new Promise(r => setTimeout(r, 2000));

  if (typeof debugAlignGroup !== 'function') {
    console.error('[AutoTest] debugAlignGroup 函数不存在，请确认 script.js 已更新');
    return;
  }

  console.log(`[AutoTest] 开始自动测试分组: "${testGroup}"`);
  await debugAlignGroup(testGroup);
  console.log('[AutoTest] ✅ 自动测试完成 — 请在浏览器中验证对齐效果');
})();
