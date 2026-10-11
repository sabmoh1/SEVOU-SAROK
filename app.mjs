import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js';
import { getDatabase, ref, get } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-database.js';

// Existing Firebase project configuration from the source project.
// Access to every path is still controlled by Firebase Realtime Database rules.
const firebaseConfig = {
  apiKey: 'AIzaSyALb-skLvuA13-PjFGYoEn72VRqOgKiwxM',
  authDomain: 'crash-db-1ff97.firebaseapp.com',
  databaseURL: 'https://crash-db-1ff97-default-rtdb.firebaseio.com',
  projectId: 'crash-db-1ff97',
  storageBucket: 'crash-db-1ff97.firebasestorage.app',
  messagingSenderId: '835131009195',
  appId: '1:835131009195:web:d6ede55751353f04ec6fee',
  measurementId: 'G-8YZDD3F6SV'
};

const ROOT_DB = firebaseConfig.databaseURL.replace(/\/$/, '');
const ACCOUNT_DB = 'https://balance-api-db-default-rtdb.firebaseio.com';
const ROWS = 10;
const COLS = 5;
const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
const firebaseDatabase = getDatabase(firebaseApp);

const card = document.querySelector('#portal-card');
const loginForm = document.querySelector('#portal-login-form');
const gamePanel = document.querySelector('#portal-game-panel');
const idInput = document.querySelector('#portal-user-id');
const keyInput = document.querySelector('#portal-access-key');
const loginButton = document.querySelector('#portal-login-button');
const startButton = document.querySelector('#portal-start-button');
const exitButton = document.querySelector('#portal-exit-button');
const activeId = document.querySelector('#portal-active-id');
const boardNode = document.querySelector('#portal-apple-board');
const errorBox = document.querySelector('#portal-error');
const errorText = document.querySelector('#portal-error-text');

let activeUserId = null;
let dataSource = 'account';
let boardMatrix = null;
let rowMultipliers = [];

function displayError(message = '') {
  errorText.textContent = message;
  errorBox.hidden = !message;
}

function toggleBusy(button, busy) {
  button.disabled = busy;
  const spinner = button.querySelector('.spinner');
  const label = button.querySelector('.button-label');
  if (spinner) spinner.hidden = !busy;
  if (label) label.hidden = busy;
}

function isKeyExpired(record) {
  if (typeof record?.expiresAt === 'number' && record.expiresAt > 0 && record.expiresAt <= Date.now()) return true;
  if (typeof record?.remainingTime === 'number' && record.remainingTime <= 0) return true;
  return false;
}

function isSafeOwnerPath(owner) {
  // Firebase path segments cannot contain . # $ [ ] / or control characters.
  return Boolean(owner) && owner.length <= 60 && !/[.#$\[\]\/\u0000-\u001F\u007F]/.test(owner);
}

async function readJson(url, label) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch {
    throw new Error(`${label}: network error. Check your internet connection and Firebase availability.`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${label}: Firebase denied the read (${response.status}). Check Realtime Database read rules.`);
    }
    throw new Error(`${label}: Firebase returned HTTP ${response.status}.`);
  }
  const data = await response.json();
  if (data && typeof data === 'object' && typeof data.error === 'string') {
    throw new Error(`${label}: ${data.error}`);
  }
  return data;
}

// Firebase REST returns arrays as arrays in some cases and numeric-key objects in others.
function asIndexedArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    if (keys.length) return keys.map(k => value[k]);
  }
  return null;
}

function asMatrix(value) {
  const rows = asIndexedArray(value);
  if (!rows) return null;
  const matrix = rows.map(row => asIndexedArray(row));
  return matrix.every(Boolean) ? matrix : null;
}

function normalizeBit(value) {
  if (value === 1 || value === '1') return 1;
  if (value === 0 || value === '0') return 0;
  return null;
}

function unpackAppleRecord(response, label) {
  const appleNode = response?.Apple ?? response;
  if (!appleNode || typeof appleNode !== 'object') throw new Error(`${label}: the Apple node is empty.`);
  if (appleNode.Success === false) throw new Error(`${label}: Apple.Success is false.`);
  const payload = appleNode.Value ?? appleNode.value ?? appleNode;
  const rawMatrix = asMatrix(payload?.AP ?? appleNode?.AP);
  if (!rawMatrix || rawMatrix.length < ROWS) throw new Error(`${label}: Apple.Value.AP must contain 10 rows.`);
  const matrix = rawMatrix.slice(0, ROWS).map((row, rowIndex) => {
    if (!row || row.length < COLS) throw new Error(`${label}: row ${rowIndex} must contain 5 cells.`);
    const bits = row.slice(0, COLS).map(normalizeBit);
    if (bits.some(bit => bit === null)) throw new Error(`${label}: AP must contain only 1 and 0 values.`);
    return bits;
  });
  const rawMultipliers = asIndexedArray(payload?.CFS ?? appleNode?.CFS) || [];
  const multipliers = rawMultipliers.map(value => value == null ? null : Number(value));
  return { AP: matrix, CFS: multipliers };
}

async function readSharedAppleBoard() {
  const response = await readJson(`${ROOT_DB}/Apple.json`, 'Shared Apple data');
  return unpackAppleRecord(response, 'Shared Apple data');
}

async function readAccountAppleBoard(id) {
  const response = await readJson(`${ACCOUNT_DB}/liveApple/${encodeURIComponent(id)}.json`, 'Account Apple data');
  if (!response) throw new Error('No Apple board was found for this account.');
  return unpackAppleRecord(response, 'Account Apple data');
}

async function verifyAppleKey(keyText) {
  // Owner is discovered from the database structure; it is not user input.
  // Expected layout: /passwords/{owner}/apple/{recordId}/password
  // Example: /passwords/SAROK/apple/-P3fP-qigd_EvMYkutHP/password
  let snapshot;
  try {
    snapshot = await get(ref(firebaseDatabase, 'passwords'));
  } catch (error) {
    console.error('SEVOU & SAROK key lookup error:', error);
    throw new Error('Could not read activation records. Check Firebase Realtime Database permissions.');
  }

  if (!snapshot.exists()) throw new Error('No activation records were found under passwords.');
  const owners = snapshot.val();
  const matches = [];

  for (const [ownerName, ownerNode] of Object.entries(owners || {})) {
    if (!isSafeOwnerPath(ownerName) || !ownerNode || typeof ownerNode !== 'object') continue;
    const appleNode = ownerNode.apple;
    if (!appleNode || typeof appleNode !== 'object') continue;

    // Support both an individual record directly under apple and the normal
    // Firebase-generated record-ID children under apple.
    const records = (typeof appleNode.password === 'string' || typeof appleNode.rz === 'string')
      ? [appleNode]
      : Object.values(appleNode);

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (record.password === keyText || record.rz === keyText) {
        matches.push({ ownerName, record });
      }
    }
  }

  if (matches.length === 0) throw new Error('Invalid activation key. Check the key and Firebase permissions.');
  if (matches.length > 1) throw new Error('This activation key appears under more than one owner. Please use a unique key.');

  const matched = matches[0];
  if (isKeyExpired(matched.record)) throw new Error('This activation key has expired.');
  return matched.ownerName;
}

function normalizeIdDigits(value) {
  const raw = String(value ?? '').trim().replace(/\s+/g, '');
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '').slice(0, 20);
  return digits ? `${hasPlus ? '+' : ''}${digits}` : '';
}

async function resolveAccountId(id) {
  const candidates = [...new Set([id, id.startsWith('+') ? id.slice(1) : id])];
  const targets = [ACCOUNT_DB, ROOT_DB];
  for (const candidate of candidates) {
    for (const base of targets) {
      const account = await readJson(`${base}/accounts/${encodeURIComponent(candidate)}.json?shallow=true`, 'Account lookup');
      if (account !== null && account !== undefined) return candidate;
    }
  }
  return null;
}

function enterBoard(id, source) {
  activeUserId = id;
  dataSource = source;
  activeId.textContent = id;
  loginForm.hidden = true;
  gamePanel.hidden = false;
  card.classList.add('is-active');
  boardMatrix = null;
  rowMultipliers = [];
  renderBoard();
}

async function onLogin(event) {
  event.preventDefault();
  displayError('');

  // IMPORTANT: inspect the raw field before trimming. A literal leading
  // U+0020 (ordinary space) selects the shared /Apple data source, matching
  // the original project. Without that space, use the account database.
  const rawEntry = idInput.value;
  const selectSharedApple = rawEntry.length > 0 && rawEntry.charCodeAt(0) === 32;
  const idText = selectSharedApple ? rawEntry.slice(1) : rawEntry;
  const id = normalizeIdDigits(idText);
  const key = keyInput.value.trim();

  if (!id || !key) {
    displayError('Enter your user ID and activation key. Add one ordinary space before the ID to select the shared Apple database.');
    return;
  }
  if (!/^\+?\d{7,20}$/.test(id)) {
    displayError('The ID should contain 7–20 digits. A single leading space selects the shared Apple database.');
    return;
  }

  toggleBusy(loginButton, true);
  try {
    // Owner is resolved by matching the key under passwords/{owner}/apple.
    await verifyAppleKey(key);

    if (selectSharedApple) {
      enterBoard(id, 'sharedApple');
    } else {
      const resolvedId = await resolveAccountId(id);
      if (!resolvedId) throw new Error('This ID was not found in the account database.');
      enterBoard(resolvedId, 'account');
    }
    sessionStorage.setItem('sevouSarokId', id);
    sessionStorage.setItem('sevouSarokSource', dataSource);
  } catch (error) {
    console.error('SEVOU & SAROK sign-in error:', error);
    displayError(error instanceof Error ? error.message : 'Login failed. Verify the key, database connection, and Firebase rules.');
  } finally {
    toggleBusy(loginButton, false);
  }
}

function renderBoard() {
  boardNode.replaceChildren();
  for (let visualRow = 0; visualRow < ROWS; visualRow++) {
    const sourceRowIndex = ROWS - 1 - visualRow;
    const row = document.createElement('div');
    row.className = 'board-row';

    const multiplier = document.createElement('div');
    multiplier.className = 'mult';
    const factor = rowMultipliers[sourceRowIndex];
    multiplier.textContent = factor == null || !Number.isFinite(factor) ? '' : `x${factor}`;

    const cells = document.createElement('div');
    cells.className = 'cells';
    for (let columnIndex = 0; columnIndex < COLS; columnIndex++) {
      const cell = document.createElement('div');
      const value = boardMatrix?.[sourceRowIndex]?.[columnIndex];
      cell.className = `cell${value === 0 || value === 1 ? '' : ' cell--wood'}`;
      if (value === 1 || value === 0) {
        const img = document.createElement('img');
        img.src = value === 1 ? 'media/img_apple_safe.png' : 'media/img_apple_risk.png';
        img.alt = value === 1 ? 'Apple value 1' : 'Apple value 0';
        cell.append(img);
      }
      cells.append(cell);
    }
    row.append(multiplier, cells);
    boardNode.append(row);
  }
}

async function onStart() {
  if (!activeUserId) return;
  displayError('');
  toggleBusy(startButton, true);
  try {
    const result = dataSource === 'sharedApple'
      ? await readSharedAppleBoard()
      : await readAccountAppleBoard(activeUserId);
    boardMatrix = result.AP;
    rowMultipliers = result.CFS;
    renderBoard();
  } catch (error) {
    console.error('SEVOU & SAROK START error:', error);
    boardMatrix = null;
    rowMultipliers = [];
    renderBoard();
    displayError(error instanceof Error ? error.message : 'Could not load the Apple data.');
  } finally {
    toggleBusy(startButton, false);
  }
}

function onExit() {
  activeUserId = null;
  dataSource = 'account';
  boardMatrix = null;
  rowMultipliers = [];
  loginForm.reset();
  loginForm.hidden = false;
  gamePanel.hidden = true;
  card.classList.remove('is-active');
  boardNode.replaceChildren();
  displayError('');
  sessionStorage.removeItem('sevouSarokId');
  sessionStorage.removeItem('sevouSarokSource');
  idInput.focus();
}

// No input listener sanitizes the ID while typing; that preserves a leading space.
loginForm.addEventListener('submit', onLogin);
startButton.addEventListener('click', onStart);
exitButton.addEventListener('click', onExit);

// Optional test-only user ID prefill; remove query strings immediately afterwards.
try {
  const params = new URLSearchParams(window.location.search);
  const presetId = params.get('userId');
  if (presetId !== null) idInput.value = presetId;
  if (window.location.search) window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
} catch { /* Ignore unavailable history APIs in embedded viewers. */ }
