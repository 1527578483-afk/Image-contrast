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
};

// compareSlots and compareOffsets are proxied to per-group storage
// so each group maintains independent compare selections.
function _ensureCompareGroup(gid) {
  if (!state._compareByGroup[gid]) {
    state._compareByGroup[gid] = {
      slots: new Array(COMPARE_SLOTS).fill(null),
      offsets: new Array(COMPARE_SLOTS).fill(0),
      duration: null,
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
  store.put({ id: group.id, name: group.name, description: group.description, color: group.color, parentId: group.parentId || null });
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
const compareMasterPlayBtn = $('#compareMasterPlayBtn');
const compareMasterBtnLabel = $('#compareMasterBtnLabel');

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

    // --- Start playback ---
    video.currentTime = 0;
    try {
      await video.play();
    } catch (playErr) {
      console.warn('[AudioAlign] 视频元素回退：play() 被拒绝:', playErr.message);
      return null;
    }

    // --- Capture audio via captureStream() + MediaRecorder ---
    // This taps into the video's decoded audio output directly, bypassing
    // the Web Audio graph entirely. More reliable than createMediaElementSource
    // + ScriptProcessorNode, especially on file:// origins.
    const stream = video.captureStream();
    const audioTracks = stream.getAudioTracks();

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

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const recorderStopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    recorder.start();

    // Record for the target duration
    await new Promise(r => setTimeout(r, captureSecs * 1000));

    // Request final data chunk and stop
    recorder.requestData();
    recorder.stop();
    video.pause();

    // Wait for the final dataavailable / stop event
    await recorderStopped;

    // Detach audio tracks
    audioTracks.forEach(t => t.stop());

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

    // --- Phase 2: compute energy envelopes & detect content boundaries ---
    const SILENT_THRESHOLD = 0.0005; // peak RMS < 0.0005 = essentially silent
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
        console.log(`[AudioAlign] 槽位 ${data.slotIdx}: 内容 ${bounds.start.toFixed(2)}s→${bounds.end.toFixed(2)}s (总长${videoDur.toFixed(1)}s), 峰值能量=${(peakEnergy*1000).toFixed(1)}e-3, 包络点数=${data.env.energies.length}`);
      }
    }

    // If no videos have audio, we can only do a basic play-all
    if (hasAudibleCount === 0) {
      showToast('所有视频均无音频轨道，无法进行音频对齐', 'error');
      resetAlignButton();
      return;
    }

    // --- Phase 3: cross-correlate energy envelopes ---
    // Strategy: pick the top-5 videos with highest peak energy as reference
    // candidates. Use #1 as primary reference; correlate every other video
    // against ALL top-5 candidates and pick the best-matching one.
    const audible = valid.filter(d => !d.isSilent);
    const corrOffsets = new Array(COMPARE_SLOTS).fill(0);

    if (audible.length >= 2) {
      // Sort by peak energy descending → clearest audio first
      const sortedByPeak = [...audible].sort((a, b) => b.peakEnergy - a.peakEnergy);
      const top5 = sortedByPeak.slice(0, Math.min(5, sortedByPeak.length));
      const primaryRef = top5[0]; // absolute highest peak

      console.log(`[AudioAlign] 🔍 波峰最高的前 ${top5.length} 个视频作为参考基准：`);
      top5.forEach((d, i) => {
        console.log(`  ${i + 1}. 槽位${d.slotIdx} (video=${d.video?.title || '?'}) 峰值能量=${(d.peakEnergy * 1000).toFixed(1)}e-3`);
      });

      // Round 1: correlate each non-primary top-5 reference against the primary
      for (let i = 1; i < top5.length; i++) {
        const tgt = top5[i];
        const avgRate = (primaryRef.env.windowRate + tgt.env.windowRate) / 2;
        const result = correlateEnvelopesRobust(primaryRef.env, tgt.env, avgRate, 120);
        corrOffsets[tgt.slotIdx] = result.offset;
        console.log(`[AudioAlign] 参考#${i + 1}(槽位${tgt.slotIdx}) vs 主参考(槽位${primaryRef.slotIdx}): 偏移=${result.offset.toFixed(3)}s, 相关系数=${result.score.toFixed(3)} (${result.score > 0.3 ? '可信' : result.score > 0.1 ? '弱' : '不可靠'})`);
      }

      // Round 2: for each remaining video, try all top-5 refs → pick best
      const remaining = audible.filter(d => !top5.includes(d));
      for (const tgt of remaining) {
        let bestScore = -Infinity;
        let bestTotalOffset = 0;
        let bestRefSlot = -1;

        for (const ref of top5) {
          const avgRate = (ref.env.windowRate + tgt.env.windowRate) / 2;
          const result = correlateEnvelopesRobust(ref.env, tgt.env, avgRate, 120);
          // Chain: ref's own offset from primary + tgt's offset from ref
          const totalOffset = (corrOffsets[ref.slotIdx] || 0) + result.offset;

          console.log(`[AudioAlign]   槽位${tgt.slotIdx} vs 参考槽位${ref.slotIdx}: 相对偏移=${result.offset.toFixed(3)}s, 总偏移=${totalOffset.toFixed(3)}s, 相关系数=${result.score.toFixed(3)}`);

          if (result.score > bestScore) {
            bestScore = result.score;
            bestTotalOffset = totalOffset;
            bestRefSlot = ref.slotIdx;
          }
        }

        corrOffsets[tgt.slotIdx] = bestTotalOffset;
        const reliable = bestScore > 0.3 ? '✓可信' : bestScore > 0.1 ? '△弱匹配' : '✗不可靠';
        console.log(`[AudioAlign] 槽位${tgt.slotIdx} → 最佳匹配: 参考槽位${bestRefSlot} (得分=${bestScore.toFixed(3)} ${reliable}), 最终偏移=${bestTotalOffset.toFixed(3)}s`);
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

    // --- Show result ---
    const silentCount = valid.length - audible.length;
    const top5Count = Math.min(5, audible.length);
    let msg = `对齐完成：以波峰最高的 ${top5Count} 个视频为基准`;
    if (silentCount > 0) {
      msg += `（${silentCount} 个视频无音频，跳过互相关）`;
    }
    msg += `，同步播放 ${commonDurationFinal.toFixed(1)}s`;
    showToast(msg, 'success');

    btnAlignAudio.classList.remove('is-processing');
    btnAlignAudio.classList.add('is-aligned');
    btnAlignAudio.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="4,12 8,5 12,19 16,9 20,12"/>
      </svg>
      已对齐`;

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
  btnAlignAudio.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4,12 8,5 12,19 16,9 20,12"/>
    </svg>
    音频对齐`;
}

/**
 * Reset alignment offsets and button state.
 */
function clearAudioAlignment() {
  state.compareOffsets = new Array(COMPARE_SLOTS).fill(0);
  state.compareDuration = null;
  btnAlignAudio.classList.remove('is-aligned');
  btnAlignAudio.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4,12 8,5 12,19 16,9 20,12"/>
    </svg>
    音频对齐`;
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
async function renderVideoToProxy(originalUrl, onProgress) {
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
  if (Math.max(w, h) > MAX_DIM) {
    const scale = MAX_DIM / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  // Ensure even dimensions (some codecs require this)
  w = w % 2 === 0 ? w : w + 1;
  h = h % 2 === 0 ? h : h + 1;

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
  const actualArea = w * h;
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

    ctx.drawImage(video, 0, 0, w, h);

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
      });

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
  // Set filled count for adaptive fullscreen grid
  const filled = state.compareSlots.filter(s => s !== null).length;
  compareSlotsEl.setAttribute('data-filled', filled);
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

      // Swap the two slots (and their alignment offsets)
      const temp = state.compareSlots[fromIdx];
      state.compareSlots[fromIdx] = state.compareSlots[i];
      state.compareSlots[i] = temp;

      const tempOffset = state.compareOffsets[fromIdx];
      state.compareOffsets[fromIdx] = state.compareOffsets[i];
      state.compareOffsets[i] = tempOffset;

      // Slot rearrangement invalidates audio alignment
      clearAudioAlignment();

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
  if (state.compareIsPlaying) { pauseCompareSlots(); }
  else { playCompareSlots(); }
});

// --- Compare Fullscreen ---
let fullscreenExitBtn = null;
let fullscreenHint = null;
let fullscreenPlayBtn = null;

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

  fitFullscreenGrid();
  window.addEventListener('resize', fitFullscreenGrid);
}

function exitCompareFullscreen() {
  // Stop any ongoing export recording
  if (exportRecording) stopExportRecording();

  viewCompare.classList.remove('compare--fullscreen');
  if (fullscreenExitBtn) fullscreenExitBtn.remove();
  fullscreenExitBtn = null;
  if (fullscreenHint) fullscreenHint.remove();
  fullscreenHint = null;
	if (fullscreenPlayBtn) fullscreenPlayBtn.remove();
	fullscreenPlayBtn = null;
	if (fullscreenExportBtn) fullscreenExportBtn.remove();
	fullscreenExportBtn = null;
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
  window.removeEventListener('resize', fitFullscreenGrid);
}

btnFullscreen.addEventListener('click', () => {
  if (viewCompare.classList.contains('compare--fullscreen')) {
    exitCompareFullscreen();
  } else {
    enterCompareFullscreen();
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
  const slotEls = compareSlotsEl.querySelectorAll('.compare-slot.has-video');
  slotEls.forEach(slotEl => {
    const video = slotEl.querySelector('video');
    if (video) {
      videos.push(video);
      // Resolve title from compare slot video ID
      const slotIdx = parseInt(slotEl.dataset.slot);
      const videoId = state.compareSlots[slotIdx];
      if (videoId) {
        const result = findVideo(videoId);
        videoTitles.push(result ? result.video.title : '');
      } else {
        videoTitles.push('');
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

      const vw = video.videoWidth || resolution.w;
      const vh = video.videoHeight || resolution.h;
      const scale = Math.min(cellW / vw, cellH / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = x + (cellW - dw) / 2;
      const dy = y + (cellH - dh) / 2;

      ctx.drawImage(video, dx, dy, dw, dh);

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

  // Find the longest video duration for progress tracking
  const offsets = state.compareOffsets || [];
  let maxEndTime = 0;
  videos.forEach((v, i) => {
    const dur = v.duration || 0;
    const offset = offsets[i] || 0;
    const endTime = Math.min(offset + dur, dur || Infinity);
    if (endTime > maxEndTime) maxEndTime = endTime;
  });
  // If we couldn't determine duration, fall back to a reasonable estimate
  if (!maxEndTime || !isFinite(maxEndTime)) maxEndTime = 30;

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
    // Track progress: use the longest-duration video's currentTime
    if (videos.length > 0 && maxEndTime > 0) {
      const cur = Math.max(...videos.map(v => v.currentTime || 0));
      updateExportProgress((cur / maxEndTime) * 100);
    }
    // Auto-stop when all videos have finished
    if (allEnded()) {
      exportRecording = false;
      if (exportRecorder && exportRecorder.state === 'recording') {
        exportRecorder.stop();
      }
      showExportDone();
      return;
    }
    animId = requestAnimationFrame(animLoop);
  }

  // Seek all videos to start (apply alignment offsets if available)
  videos.forEach((v, i) => {
    const offset = offsets[i] || 0;
    v.currentTime = Math.max(0, offset);
    v.muted = true;
  });

  // Wait briefly for seek, then start recording
  await new Promise(r => setTimeout(r, 200));

  exportRecording = true;
  recorder.start(100); // collect data every 100ms

  // Play all videos
  try {
    await Promise.all(videos.map(v => v.play()));
  } catch (e) {
    // autoplay might be blocked
  }

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
async function trimAndDownloadVideo(videoUrl, startSec, durationSec, title) {
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
    // If the stored metadata has fps, prefer it
    // (we'll use our detected fps as fallback)
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

  // Seek to start position
  video.currentTime = Math.max(0, startSec);
  await new Promise(r => setTimeout(r, 300));

  recorder.start(100);
  await video.play();

  // Draw loop — stop after durationSec
  const startTime = performance.now();
  const targetMs = durationSec * 1000;

  await new Promise((resolve) => {
    const drawLoop = () => {
      if (video.ended || performance.now() - startTime >= targetMs) {
        if (recorder.state === 'recording') recorder.stop();
        resolve();
        return;
      }
      if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, w, h);
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
      await trimAndDownloadVideo(video.url, offset, commonDuration, video.title);
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
  const hasOffsets = offsets.some(o => o !== 0) || commonDur !== null;

  // Clear any previous end-of-playback timer
  if (_comparePlaybackTimer) { clearTimeout(_comparePlaybackTimer); _comparePlaybackTimer = null; }

  // --- Step 1: seek all videos to their aligned positions ---
  const videos = [];
  const seekPromises = [];

  slots.forEach((slot, i) => {
    const video = slot.querySelector('video');
    if (video) {
      videos.push(video);
      const startTime = hasOffsets ? Math.max(0, offsets[i] || 0) : 0;
      if (startTime > 0 && startTime < (video.duration || Infinity)) {
        console.log(`[Compare] 槽位 ${i}: seek 到 ${startTime.toFixed(2)}s (视频总长 ${video.duration?.toFixed(1) || '未知'}s, 偏移=${offsets[i]?.toFixed(2) || 0}s)`);
        seekPromises.push(waitForReadyAndSeek(video, startTime));
      } else {
        console.log(`[Compare] 槽位 ${i}: 从头播放 (startTime=${startTime}, duration=${video.duration})`);
      }
    }
  });

  // Wait for all seeks to complete before playing
  if (seekPromises.length > 0) {
    console.log(`[Compare] 等待 ${seekPromises.length} 个视频 seek 到位…`);
    await Promise.all(seekPromises);
    // Verify seeks actually happened
    slots.forEach((slot, i) => {
      const video = slot.querySelector('video');
      if (video) {
        const targetTime = hasOffsets ? Math.max(0, offsets[i] || 0) : 0;
        const actualTime = video.currentTime;
        if (targetTime > 0) {
          console.log(`[Compare] 槽位 ${i} seek 验证: 目标=${targetTime.toFixed(2)}s, 实际=${actualTime.toFixed(2)}s, 误差=${(Math.abs(actualTime - targetTime) * 1000).toFixed(0)}ms`);
        }
      }
    });
    console.log('[Compare] 所有 seek 完成，同步播放');
  }

  // --- Step 2: play all videos simultaneously ---
  const playResults = await Promise.allSettled(
    videos.map(video => video.play())
  );
  const started = playResults.some(r => r.status === 'fulfilled');

  // Log any failures
  playResults.forEach((r, idx) => {
    if (r.status === 'rejected') {
      console.warn(`[Compare] 槽位 ${idx} 播放失败:`, r.reason?.message);
    }
  });

  // --- Step 3: schedule auto-pause ---
  if (commonDur && commonDur > 0 && started) {
    _comparePlaybackTimer = setTimeout(() => {
      pauseCompareSlots();
      _comparePlaybackTimer = null;
    }, commonDur * 1000);
  }

  if (started) {
    state.compareIsPlaying = true;
    compareMasterPlayBtn.classList.add('is-playing');
    compareMasterBtnLabel.textContent = '同步暂停';
    if (fullscreenPlayBtn) fullscreenPlayBtn.classList.add('is-playing');
  }
}

function pauseCompareSlots() {
  if (_comparePlaybackTimer) { clearTimeout(_comparePlaybackTimer); _comparePlaybackTimer = null; }
  const slots = compareSlotsEl.querySelectorAll('.compare-slot');
  slots.forEach(slot => { const v = slot.querySelector('video'); if (v) v.pause(); });
  state.compareIsPlaying = false;
  compareMasterPlayBtn.classList.remove('is-playing');
  compareMasterBtnLabel.textContent = '同步播放';
  if (fullscreenPlayBtn) fullscreenPlayBtn.classList.remove('is-playing');
}

function pauseAllCompareSlots() {
  if (_comparePlaybackTimer) { clearTimeout(_comparePlaybackTimer); _comparePlaybackTimer = null; }
  const slots = compareSlotsEl.querySelectorAll('.compare-slot');
  slots.forEach(slot => {
    const v = slot.querySelector('video');
    if (v) { v.pause(); v.remove(); }
  });
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
