import { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'webp', 'gif', 'png', 'bmp', 'tiff', 'svg', 'avif'];

/**
 * Returns an AWS credential provider function that fetches temporary credentials
 * from a user-supplied backend endpoint.
 *
 * The endpoint must return JSON with the shape:
 *   { access_key_id, secret_access_key, session_token?, expiry? }
 *
 * When `expiry` (ISO 8601) is included the AWS SDK will automatically call this
 * provider again before the credentials expire.
 */
export function makeCredentialsProvider(credentialsEndpoint) {
  return async () => {
    const response = await fetch(credentialsEndpoint);
    if (!response.ok) {
      throw new Error(
        `[decap-cms-media-library-s3] Failed to fetch credentials from ${credentialsEndpoint}: ${response.status} ${response.statusText}`,
      );
    }
    const data = await response.json();
    const creds = {
      accessKeyId: data.access_key_id,
      secretAccessKey: data.secret_access_key,
    };
    if (data.session_token) creds.sessionToken = data.session_token;
    if (data.expiry) creds.expiration = new Date(data.expiry);
    return creds;
  };
}
const PRESIGNED_URL_EXPIRY = 300; // 5 minutes

function trimTrailingSlashes(str) {
  let end = str.length;
  while (end > 0 && str[end - 1] === '/') end--;
  return str.slice(0, end);
}

function getFileExtension(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function isImage(filename) {
  return IMAGE_EXTENSIONS.includes(getFileExtension(filename));
}

/**
 * Build the permanent public URL for an S3 object key.
 * - If base_url is set: `${base_url}/${key}`
 * - Otherwise for AWS (no endpoint): virtual-hosted style URL
 * - Otherwise for custom endpoint: path-style URL
 */
export function buildPublicUrl({ key, bucket, region, endpoint, baseUrl }) {
  if (baseUrl) {
    return `${trimTrailingSlashes(baseUrl)}/${key}`;
  }
  if (endpoint) {
    return `${trimTrailingSlashes(endpoint)}/${bucket}/${key}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

const MODAL_STYLES = `
  .cms-s3-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cms-s3-modal {
    background: #fff;
    border-radius: 6px;
    box-shadow: 0 4px 32px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    width: min(900px, 95vw);
    height: min(680px, 92vh);
    overflow: hidden;
  }
  .cms-s3-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid #e0e0e0;
    flex-shrink: 0;
  }
  .cms-s3-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    flex-shrink: 0;
    color: #222;
  }
  .cms-s3-search {
    flex: 1;
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 13px;
    outline: none;
  }
  .cms-s3-search:focus {
    border-color: #3a86ff;
    box-shadow: 0 0 0 2px rgba(58, 134, 255, 0.2);
  }
  .cms-s3-close {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    color: #666;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .cms-s3-close:hover { background: #f0f0f0; color: #333; }
  .cms-s3-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    position: relative;
  }
  .cms-s3-drop-zone {
    border: 2px dashed #ccc;
    border-radius: 8px;
    padding: 32px;
    text-align: center;
    color: #999;
    font-size: 14px;
    margin-bottom: 16px;
    transition: border-color 0.2s, background 0.2s;
  }
  .cms-s3-drop-zone.dragover {
    border-color: #3a86ff;
    background: rgba(58, 134, 255, 0.05);
    color: #3a86ff;
  }
  .cms-s3-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px;
  }
  .cms-s3-card {
    border: 2px solid #e0e0e0;
    border-radius: 6px;
    cursor: pointer;
    overflow: hidden;
    background: #f9f9f9;
    display: flex;
    flex-direction: column;
    transition: border-color 0.15s;
  }
  .cms-s3-card:hover { border-color: #aaa; }
  .cms-s3-card.selected { border-color: #3a86ff; background: #eef4ff; }
  .cms-s3-card-thumb {
    width: 100%;
    aspect-ratio: 1 / 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #eee;
    flex-shrink: 0;
  }
  .cms-s3-card-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .cms-s3-card-icon {
    font-size: 36px;
    line-height: 1;
    user-select: none;
  }
  .cms-s3-card-name {
    padding: 4px 6px;
    font-size: 11px;
    color: #444;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }
  .cms-s3-load-more {
    grid-column: 1 / -1;
    text-align: center;
    padding: 12px;
  }
  .cms-s3-load-more button {
    background: #f4f4f4;
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 8px 20px;
    cursor: pointer;
    font-size: 13px;
  }
  .cms-s3-load-more button:hover { background: #e8e8e8; }
  .cms-s3-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid #e0e0e0;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .cms-s3-status {
    font-size: 13px;
    color: #666;
    min-width: 120px;
  }
  .cms-s3-status.error { color: #d32f2f; }
  .cms-s3-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .cms-s3-btn {
    border: 1px solid #ccc;
    background: #fff;
    border-radius: 4px;
    padding: 7px 14px;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .cms-s3-btn:hover:not(:disabled) { background: #f4f4f4; }
  .cms-s3-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .cms-s3-btn-primary {
    background: #3a86ff;
    border-color: #3a86ff;
    color: #fff;
    font-weight: 600;
  }
  .cms-s3-btn-primary:hover:not(:disabled) { background: #1a6ae8; border-color: #1a6ae8; }
  .cms-s3-btn-danger { border-color: #e53935; color: #e53935; }
  .cms-s3-btn-danger:hover:not(:disabled) { background: #fdecea; }
  .cms-s3-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #ccc;
    border-top-color: #3a86ff;
    border-radius: 50%;
    animation: cms-s3-spin 0.7s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }
  @keyframes cms-s3-spin { to { transform: rotate(360deg); } }
`;

function injectStyles() {
  if (document.getElementById('cms-s3-styles')) return;
  const style = document.createElement('style');
  style.id = 'cms-s3-styles';
  style.textContent = MODAL_STYLES;
  document.head.appendChild(style);
}

function createModal() {
  const overlay = document.createElement('div');
  overlay.className = 'cms-s3-overlay';
  overlay.style.display = 'none';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'S3 Media Library');

  overlay.innerHTML = `
    <div class="cms-s3-modal">
      <div class="cms-s3-header">
        <h2>Media Library</h2>
        <input class="cms-s3-search" type="text" placeholder="Search files…" aria-label="Search files">
        <button class="cms-s3-close" aria-label="Close">&#x2715;</button>
      </div>
      <div class="cms-s3-body">
        <div class="cms-s3-drop-zone">Drag &amp; drop files here to upload</div>
        <div class="cms-s3-grid"></div>
      </div>
      <div class="cms-s3-footer">
        <span class="cms-s3-status"></span>
        <div class="cms-s3-actions">
          <label class="cms-s3-btn cms-s3-btn-upload" style="cursor:pointer">
            Upload
            <input type="file" multiple style="display:none" class="cms-s3-file-input">
          </label>
          <button class="cms-s3-btn cms-s3-btn-danger cms-s3-btn-delete" disabled>Delete</button>
          <button class="cms-s3-btn cms-s3-btn-cancel">Cancel</button>
          <button class="cms-s3-btn cms-s3-btn-primary cms-s3-btn-select" disabled>Choose selected</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  return overlay;
}

async function init({ options = {}, handleInsert } = {}) {
  const {
    bucket,
    region = 'us-east-1',
    credentials,
    credentials_endpoint,
    endpoint,
    force_path_style,
    folder = '',
    base_url,
  } = options.config || {};

  const forcePathStyle = force_path_style != null ? force_path_style : Boolean(endpoint);

  const clientConfig = {
    region,
    forcePathStyle,
  };

  if (credentials_endpoint) {
    // Fetch credentials from a backend endpoint so secrets never appear in config.yml.
    // The AWS SDK will re-invoke the provider before `expiration` if the endpoint
    // returns an `expiry` field.
    clientConfig.credentials = makeCredentialsProvider(credentials_endpoint);
  } else if (credentials) {
    clientConfig.credentials = {
      accessKeyId: credentials.access_key_id,
      secretAccessKey: credentials.secret_access_key,
      ...(credentials.session_token ? { sessionToken: credentials.session_token } : {}),
    };
  }

  if (endpoint) {
    clientConfig.endpoint = endpoint;
  }

  const s3 = new S3Client(clientConfig);

  const keyPrefix = folder ? trimTrailingSlashes(folder) + '/' : '';

  // ── State ─────────────────────────────────────────────────────────────────
  let selectedFiles = []; // array of key strings
  let allFiles = []; // array of { key, size, lastModified }
  let continuationToken = null;
  let hasMore = false;
  let allowMultipleSelection = false;
  let isLoading = false;
  let searchQuery = '';
  let insertCallback = null; // resolved by show(); called after user picks files

  // ── DOM ───────────────────────────────────────────────────────────────────
  injectStyles();
  const overlay = createModal();
  const grid = overlay.querySelector('.cms-s3-grid');
  const statusEl = overlay.querySelector('.cms-s3-status');
  const searchInput = overlay.querySelector('.cms-s3-search');
  const closeBtn = overlay.querySelector('.cms-s3-close');
  const fileInput = overlay.querySelector('.cms-s3-file-input');
  const deleteBtn = overlay.querySelector('.cms-s3-btn-delete');
  const cancelBtn = overlay.querySelector('.cms-s3-btn-cancel');
  const selectBtn = overlay.querySelector('.cms-s3-btn-select');
  const dropZone = overlay.querySelector('.cms-s3-drop-zone');

  // ── Helpers ───────────────────────────────────────────────────────────────

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = `cms-s3-status${isError ? ' error' : ''}`;
  }

  function updateActionButtons() {
    const hasSelection = selectedFiles.length > 0;
    deleteBtn.disabled = !hasSelection;
    selectBtn.disabled = !hasSelection;
  }

  async function getDisplayUrl(key) {
    if (base_url) {
      return buildPublicUrl({ key, bucket, region, endpoint, baseUrl: base_url });
    }
    try {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      return await getSignedUrl(s3, command, { expiresIn: PRESIGNED_URL_EXPIRY });
    } catch {
      return buildPublicUrl({ key, bucket, region, endpoint, baseUrl: base_url });
    }
  }

  function renderCard(file) {
    const card = document.createElement('div');
    card.className = 'cms-s3-card';
    card.dataset.key = file.key;

    const name = file.key.replace(keyPrefix, '');
    const thumb = document.createElement('div');
    thumb.className = 'cms-s3-card-thumb';

    if (isImage(name)) {
      const img = document.createElement('img');
      img.alt = name;
      img.loading = 'lazy';
      getDisplayUrl(file.key).then(url => {
        img.src = url;
      });
      thumb.appendChild(img);
    } else {
      const icon = document.createElement('span');
      icon.className = 'cms-s3-card-icon';
      icon.textContent = '📄';
      thumb.appendChild(icon);
    }

    const label = document.createElement('div');
    label.className = 'cms-s3-card-name';
    label.title = name;
    label.textContent = name;

    card.appendChild(thumb);
    card.appendChild(label);

    card.addEventListener('click', () => {
      if (allowMultipleSelection) {
        const idx = selectedFiles.indexOf(file.key);
        if (idx >= 0) {
          selectedFiles.splice(idx, 1);
          card.classList.remove('selected');
        } else {
          selectedFiles.push(file.key);
          card.classList.add('selected');
        }
      } else {
        // Deselect previous
        overlay.querySelectorAll('.cms-s3-card.selected').forEach(el => el.classList.remove('selected'));
        selectedFiles = [file.key];
        card.classList.add('selected');
      }
      updateActionButtons();
    });

    card.addEventListener('dblclick', () => {
      if (!selectedFiles.includes(file.key)) {
        overlay.querySelectorAll('.cms-s3-card.selected').forEach(el => el.classList.remove('selected'));
        selectedFiles = [file.key];
        card.classList.add('selected');
        updateActionButtons();
      }
      handleSelect();
    });

    return card;
  }

  function getFilteredFiles() {
    if (!searchQuery) return allFiles;
    const q = searchQuery.toLowerCase();
    return allFiles.filter(f => f.key.replace(keyPrefix, '').toLowerCase().includes(q));
  }

  function renderGrid() {
    // Remove existing load-more row
    const existing = grid.querySelector('.cms-s3-load-more');
    if (existing) existing.remove();

    const files = getFilteredFiles();
    // Clear selection
    selectedFiles = [];
    updateActionButtons();

    // Clear grid cards (not load-more, it was already removed)
    grid.innerHTML = '';

    files.forEach(file => grid.appendChild(renderCard(file)));

    if (hasMore && !searchQuery) {
      const loadMoreRow = document.createElement('div');
      loadMoreRow.className = 'cms-s3-load-more';
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.textContent = 'Load more';
      loadMoreBtn.addEventListener('click', () => loadMore());
      loadMoreRow.appendChild(loadMoreBtn);
      grid.appendChild(loadMoreRow);
    }
  }

  async function loadFiles(reset = true) {
    if (isLoading) return;
    isLoading = true;

    if (reset) {
      continuationToken = null;
      allFiles = [];
    }

    setStatus('Loading…');

    try {
      const params = {
        Bucket: bucket,
        Prefix: keyPrefix || undefined,
        MaxKeys: 200,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      };

      const response = await s3.send(new ListObjectsV2Command(params));

      const newFiles = (response.Contents || [])
        .filter(obj => !obj.Key.endsWith('/')) // exclude folder placeholders
        .map(obj => ({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
        }));

      if (reset) {
        allFiles = newFiles;
      } else {
        allFiles = [...allFiles, ...newFiles];
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
      hasMore = Boolean(response.IsTruncated);
      setStatus(`${allFiles.length} file${allFiles.length !== 1 ? 's' : ''}`);
      renderGrid();
    } catch (err) {
      console.error('[decap-cms-media-library-s3] loadFiles error:', err);
      setStatus(`Error loading files: ${err.message}`, true);
    } finally {
      isLoading = false;
    }
  }

  async function loadMore() {
    if (!hasMore || isLoading) return;
    await loadFiles(false);
  }

  function handleSelect() {
    if (selectedFiles.length === 0) return;

    const urls = selectedFiles.map(key =>
      buildPublicUrl({ key, bucket, region, endpoint, baseUrl: base_url }),
    );

    const result = allowMultipleSelection || urls.length > 1 ? urls : urls[0];

    if (typeof handleInsert === 'function') {
      handleInsert(result);
    }
    if (typeof insertCallback === 'function') {
      insertCallback(result);
    }
    hideModal();
  }

  async function handleDelete() {
    if (selectedFiles.length === 0) return;
    const names = selectedFiles.map(k => k.replace(keyPrefix, '')).join(', ');
    if (!window.confirm(`Delete ${selectedFiles.length > 1 ? 'these files' : `"${names}"`}?`)) {
      return;
    }

    setStatus('Deleting…');
    deleteBtn.disabled = true;

    try {
      await Promise.all(
        selectedFiles.map(key => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))),
      );
      allFiles = allFiles.filter(f => !selectedFiles.includes(f.key));
      selectedFiles = [];
      updateActionButtons();
      setStatus(`Deleted "${names}"`);
      renderGrid();
    } catch (err) {
      console.error('[decap-cms-media-library-s3] delete error:', err);
      setStatus(`Delete failed: ${err.message}`, true);
    }
  }

  async function uploadFile(file) {
    const key = keyPrefix + file.name;
    setStatus(`Uploading "${file.name}"…`);

    try {
      const upload = new Upload({
        client: s3,
        params: {
          Bucket: bucket,
          Key: key,
          Body: file,
          ContentType: file.type || 'application/octet-stream',
        },
      });

      await upload.done();

      const newFile = { key, size: file.size, lastModified: new Date() };
      allFiles = [newFile, ...allFiles];
      renderGrid();
      setStatus(`Uploaded "${file.name}"`);
    } catch (err) {
      console.error('[decap-cms-media-library-s3] upload error:', err);
      setStatus(`Upload failed: ${err.message}`, true);
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  closeBtn.addEventListener('click', hideModal);
  cancelBtn.addEventListener('click', hideModal);
  selectBtn.addEventListener('click', handleSelect);
  deleteBtn.addEventListener('click', handleDelete);

  searchInput.addEventListener('input', e => {
    searchQuery = e.target.value;
    renderGrid();
  });

  fileInput.addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      await uploadFile(file);
    }
    e.target.value = '';
  });

  // Drag & drop
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files || []);
    for (const file of files) {
      await uploadFile(file);
    }
  });

  // Close on overlay background click
  overlay.addEventListener('click', e => {
    if (e.target === overlay) hideModal();
  });

  // ── Public API ────────────────────────────────────────────────────────────

  function showModal({ allowMultiple } = {}) {
    allowMultipleSelection = Boolean(allowMultiple);
    selectedFiles = [];
    searchQuery = '';
    searchInput.value = '';
    updateActionButtons();
    overlay.style.display = 'flex';
    loadFiles(true);
    return new Promise(resolve => {
      insertCallback = resolve;
    });
  }

  function hideModal() {
    overlay.style.display = 'none';
    insertCallback = null;
  }

  return {
    show: showModal,
    hide: hideModal,
    enableStandalone: () => true,
  };
}

const s3MediaLibrary = { name: 's3', init };

export const DecapCmsMediaLibraryS3 = s3MediaLibrary;
export default s3MediaLibrary;
