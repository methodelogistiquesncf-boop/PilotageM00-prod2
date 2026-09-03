// firebase.js — v5 : optimisé (cache localStorage + listeners ciblés + historique paresseux)

import { state, setState, onDirty, markDirty, ENGINS_CONFIG, ensureFullStructure, setCustomRoles, setRemovedRoles } from './state.js';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDYo1JH1uqYX6OsHdV9QjtaG6CjP9gLQEo",
  authDomain: "pilotagem00-prod2.firebaseapp.com",
  projectId: "pilotagem00-prod2",
  storageBucket: "pilotagem00-prod2.firebasestorage.app",
  messagingSenderId: "66122797161",
  appId: "1:66122797161:web:61468faf9ea1ffaf6cd2f8"
};
const FIRESTORE_DOC = "suivi/default";

let db = null;
let saveTimer = null;
let auth = null;
let loadedActionIds = [];
let loadedHistDates = [];
let dirty = false;
let pendingApply = false;
let lastLocalSavedAt = '';
let rtStarted = false;
let usersCache = { data: [], ts: 0 };
let userDirectoryCache = { data: [], ts: 0 };
const USERS_CACHE_TTL = 5 * 60 * 1000;

// Cache persistant
let dataCache = JSON.parse(localStorage.getItem('dataCache') || '{}');
let lastSyncTimestamp = localStorage.getItem('lastSyncTimestamp') || '0';

function saveToCache() {
  try {
    localStorage.setItem('dataCache', JSON.stringify(dataCache));
    localStorage.setItem('lastSyncTimestamp', lastSyncTimestamp);
  } catch (e) {
    console.warn('Cache localStorage plein');
  }
}

export function getDb() { return db; }

function setStatus(type, msg) {
  var el = document.getElementById('fbStatus');
  el.className = type;
  el.textContent = msg;
}

export function doLogout() {
  auth.signOut().then(function () { window.location.href = 'login.html'; });
}

export function initAuth(onLogin) {
  firebase.initializeApp(FIREBASE_CONFIG);
  auth = firebase.auth();
  auth.onAuthStateChanged(function (user) {
    if (!user) { window.location.href = 'login.html'; return; }
    document.getElementById('userBadge').style.display = 'flex';
    db = firebase.firestore();
    setStatus('sync', 'Chargement...');
    ensureUserDoc(user)
      .then(function () { updateUserBadge(); return loadFirebase(); })
      .then(function () { onLogin(user); });
  });
}

export function updateUserBadge() {
  var el = document.getElementById('userEmail');
  if (!el) return;
  var fullName = (state.currentUserPrenom + ' ' + state.currentUserNom).trim();
  el.textContent = '👤 ' + (fullName || state.currentUserEmail);
  var rb = document.getElementById('userRoleBadge');
  if (rb) {
    var r = (state.currentUserRole || '').trim();
    rb.textContent = r;
    rb.style.display = r ? 'inline-block' : 'none';
  }
}

async function ensureUserDoc(user) {
  var userRef = db.collection('users').doc(user.uid);
  var bootstrapRef = db.collection('meta').doc('bootstrap');
  try {
    await db.runTransaction(async function (tx) {
      var userSnap = await tx.get(userRef);
      if (userSnap.exists) {
        tx.update(userRef, { lastLogin: new Date().toISOString(), email: user.email });
        return;
      }
      var bootSnap = await tx.get(bootstrapRef);
      var isFirstEver = !bootSnap.exists;
      tx.set(userRef, {
        email: user.email,
        role: isFirstEver ? 'Administrateur' : '',
        prenom: '',
        nom: '',
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      });
      if (isFirstEver) {
        tx.set(bootstrapRef, { adminAssigned: true, assignedTo: user.uid, assignedAt: new Date().toISOString() });
      }
    });
    var finalSnap = await userRef.get();
    var data = finalSnap.data();
    state.currentUserUid = user.uid;
    state.currentUserEmail = data.email || user.email;
    state.currentUserRole = data.role || '';
    state.currentUserPrenom = data.prenom || '';
    state.currentUserNom = data.nom || '';
  } catch (e) {
    console.error('Erreur ensureUserDoc', e);
    state.currentUserUid = user.uid;
    state.currentUserEmail = user.email;
    state.currentUserRole = '';
    state.currentUserPrenom = '';
    state.currentUserNom = '';
  }
}

export async function createUser(email, role, prenom, nom) {
  var tempPassword = generateTempPassword();
  var secondaryApp = firebase.initializeApp(FIREBASE_CONFIG, 'secondary_' + Date.now());
  try {
    var secondaryAuth = secondaryApp.auth();
    var cred = await secondaryAuth.createUserWithEmailAndPassword(email, tempPassword);
    var uid = cred.user.uid;
    await db.collection('users').doc(uid).set({
      email: email,
      role: role || '',
      prenom: (prenom || '').trim(),
      nom: (nom || '').trim(),
      createdAt: new Date().toISOString(),
      lastLogin: '',
      createdBy: state.currentUserUid
    });
    await secondaryAuth.signOut();
    await auth.sendPasswordResetEmail(email);
    usersCache.ts = 0;
    return { uid: uid };
  } finally {
    await secondaryApp.delete();
  }
}

function generateTempPassword() {
  var arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

export async function loadUsersList() {
  var now = Date.now();
  if (usersCache.data.length && (now - usersCache.ts) < USERS_CACHE_TTL) {
    return usersCache.data;
  }
  var snap = await db.collection('users').orderBy('email').get();
  usersCache.data = snap.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); });
  usersCache.ts = now;
  return usersCache.data;
}

export async function tryLoadUserDirectory() {
  if (!db) return [];
  var now = Date.now();
  if (userDirectoryCache.data.length && (now - userDirectoryCache.ts) < USERS_CACHE_TTL) {
    return userDirectoryCache.data;
  }
  try {
    var snap = await db.collection('users').orderBy('email').get();
    userDirectoryCache.data = snap.docs.map(function (d) {
      var data = d.data();
      return { email: data.email || '', prenom: data.prenom || '', nom: data.nom || '' };
    }).filter(function (u) { return u.email; });
    userDirectoryCache.ts = now;
    return userDirectoryCache.data;
  } catch (e) {
    return [];
  }
}

export async function updateUserRole(uid, role) {
  await db.collection('users').doc(uid).update({ role: role });
  if (uid === state.currentUserUid) { state.currentUserRole = role; updateUserBadge(); }
  usersCache.ts = 0;
}

export async function updateUserProfile(uid, patch) {
  await db.collection('users').doc(uid).update(patch);
  usersCache.ts = 0;
}

export async function deleteUserDoc(uid) {
  await db.collection('users').doc(uid).delete();
  usersCache.ts = 0;
}

function isoDaysAgo(n) {
  var d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

function purgeOldData() {
  var changed = false;
  var cut90 = isoDaysAgo(90);
  var cut540 = isoDaysAgo(540);

  var nAct = state.actions.length;
  state.actions = state.actions.filter(function (a) {
    return !(a.done && (a.doneAt || '').slice(0, 10) && (a.doneAt || '').slice(0, 10) < cut90);
  });
  if (state.actions.length !== nAct) changed = true;

  Object.keys(state.historique).forEach(function (d) {
    if (d < cut540) { delete state.historique[d]; changed = true; }
  });

  var nRas = state.rassemblement.length;
  state.rassemblement = state.rassemblement.filter(function (sec) {
    var allRecu = sec.rows && sec.rows.length > 0 && sec.rows.every(function (r) { return r.recu; });
    return !(allRecu && sec.date && sec.date < cut90);
  });
  if (state.rassemblement.length !== nRas) changed = true;

  if (changed) {
    console.info('🧹 Purge automatique');
    markDirty();
  }
}

async function fetchAll() {
  var parts = FIRESTORE_DOC.split('/');
  var snap = await db.collection(parts[0]).doc(parts[1]).get();
  var patch = {};
  var dateJourSaved = '';
  var savedAt = '';
  
  if (snap.exists) {
    var data = snap.data() || {};
    ['S', 'S_SC', 'S_TT', 'headersData', 'enginLabels', 'enginLabels_SC', 'enginLabels_TT', 'synthCols', 'colOrder', 'rassemblement', 'customRoles', 'removedRoles'].forEach(function (k) {
      if (data[k] !== undefined) patch[k] = data[k];
    });
    dateJourSaved = data.dateJour || '';
    savedAt = data.savedAt || '';
  }
  
  var hist = dataCache.historique || {};
  var acts = dataCache.actions || [];
  
  if (lastSyncTimestamp !== '0') {
    var histSnap = await db.collection('historique').where('updatedAt', '>', lastSyncTimestamp).get();
    histSnap.forEach(function (d) { hist[d.id] = d.data(); });
    
    var actSnap = await db.collection('actions').where('updatedAt', '>', lastSyncTimestamp).get();
    actSnap.forEach(function (d) {
      var a = d.data() || {};
      if (!a.id) a.id = d.id;
      acts.push(a);
    });
  } else {
    var histSnap = await db.collection('historique').get();
    histSnap.forEach(function (d) { hist[d.id] = d.data(); });
    
    var actSnap = await db.collection('actions').get();
    actSnap.forEach(function (d) {
      var a = d.data() || {};
      if (!a.id) a.id = d.id;
      acts.push(a);
    });
  }
  
  dataCache.historique = hist;
  dataCache.actions = acts;
  lastSyncTimestamp = new Date().toISOString();
  saveToCache();
  
  var actIds = acts.map(function (a) { return a.id; });
  return { patch: patch, dateJourSaved: dateJourSaved, savedAt: savedAt, hist: hist, acts: acts, actIds: actIds };
}

function applyFetched(r) {
  setState(r.patch);
  state.historique = r.hist;
  loadedHistDates = Object.keys(r.hist);
  state.actions = r.acts;
  loadedActionIds = r.actIds;
  ensureFullStructure();
  setCustomRoles(state.customRoles || []);
  setRemovedRoles(state.removedRoles || []);
  if (r.dateJourSaved) document.getElementById('dateJour').value = r.dateJourSaved;
  lastLocalSavedAt = r.savedAt;
}

function rebuildUI() {
  if (typeof window.rebuildAllViews === 'function') window.rebuildAllViews();
}

export async function loadFirebase() {
  try {
    var r = await fetchAll();
    applyFetched(r);
    purgeOldData();
    setStatus('ok', '✓ Synchronisé');
    startRealtime();
  } catch (e) {
    setStatus('err', 'Erreur lecture Firebase');
    console.error(e);
    loadLocal();
  }
}

function startRealtime() {
  if (rtStarted || !db) return;
  rtStarted = true;
  
  db.collection('suivi').doc('default').onSnapshot(function (snap) {
    if (!snap.exists) return;
    var data = snap.data() || {};
    if (data.savedAt && data.savedAt === lastLocalSavedAt) return;
    
    var patch = {};
    ['S', 'S_SC', 'S_TT', 'headersData', 'enginLabels', 'enginLabels_SC', 'enginLabels_TT', 'synthCols', 'colOrder', 'rassemblement', 'customRoles', 'removedRoles'].forEach(function (k) {
      if (data[k] !== undefined) patch[k] = data[k];
    });
    
    setState(patch);
    ensureFullStructure();
    if (data.dateJour) document.getElementById('dateJour').value = data.dateJour;
    lastLocalSavedAt = data.savedAt;
    rebuildUI();
  }, function (e) { console.error('RT suivi :', e); });
  
  db.collection('historique').onSnapshot(function (snapshot) {
    snapshot.docChanges().forEach(function (change) {
      var docData = change.doc.data();
      
      if (change.type === 'added' || change.type === 'modified') {
        if (docData.updatedAt && docData.updatedAt > lastSyncTimestamp) {
          state.historique[change.doc.id] = docData;
          dataCache.historique = dataCache.historique || {};
          dataCache.historique[change.doc.id] = docData;
        }
      }
      
      if (change.type === 'removed') {
        delete state.historique[change.doc.id];
        if (dataCache.historique) delete dataCache.historique[change.doc.id];
      }
    });
    
    loadedHistDates = Object.keys(state.historique);
    saveToCache();
    rebuildUI();
  }, function (e) { console.error('RT historique :', e); });
  
  db.collection('actions').onSnapshot(function (snapshot) {
    snapshot.docChanges().forEach(function (change) {
      var docData = change.doc.data();
      
      if (change.type === 'added' || change.type === 'modified') {
        if (docData.updatedAt && docData.updatedAt > lastSyncTimestamp) {
          var a = Object.assign({ id: change.doc.id }, docData);
          var idx = state.actions.findIndex(function (x) { return x.id === a.id; });
          if (idx >= 0) state.actions[idx] = a;
          else state.actions.push(a);
          
          dataCache.actions = dataCache.actions || [];
          var cacheIdx = dataCache.actions.findIndex(function (x) { return x.id === a.id; });
          if (cacheIdx >= 0) dataCache.actions[cacheIdx] = a;
          else dataCache.actions.push(a);
        }
      }
      
      if (change.type === 'removed') {
        state.actions = state.actions.filter(function (a) { return a.id !== change.doc.id; });
        if (dataCache.actions) dataCache.actions = dataCache.actions.filter(function (a) { return a.id !== change.doc.id; });
        loadedActionIds = state.actions.map(function (a) { return a.id; });
      }
    });
    
    loadedActionIds = state.actions.map(function (a) { return a.id; });
    saveToCache();
    rebuildUI();
  }, function (e) { console.error('RT actions :', e); });
}

export async function saveFirebase() {
  var dateJour = document.getElementById('dateJour').value;

  if (dateJour) {
    var p0 = state.colOrder[0];
    var entree = { date: dateJour, savedAt: new Date().toISOString(), engins: {} };
    ENGINS_CONFIG.forEach(function (e) {
      entree.engins[e.id] = { loco: state.S[e.id] ? (state.S[e.id].loco[p0] || '') : '' };
      e.sections.forEach(function (sec) {
        var cell = state.S[e.id] && state.S[e.id][sec] ? state.S[e.id][sec][p0] : { score: '', dot: null };
        entree.engins[e.id][sec] = { score: cell.score || '', dot: cell.dot || null };
      });
    });
    state.historique[dateJour] = entree;
  }

  try {
    localStorage.setItem('sp_backup', JSON.stringify({
      S: state.S, S_SC: state.S_SC, S_TT: state.S_TT,
      headersData: state.headersData,
      enginLabels: state.enginLabels, enginLabels_SC: state.enginLabels_SC, enginLabels_TT: state.enginLabels_TT,
      synthCols: state.synthCols, historique: state.historique,
      colOrder: state.colOrder, rassemblement: state.rassemblement, actions: state.actions,
      dateJour: dateJour, savedAt: new Date().toISOString()
    }));
  } catch (e) {}

  if (!db) { setStatus('err', 'Firebase non connecté'); return; }
  try {
    setStatus('sync', 'Sauvegarde...');
    var savedAt = new Date().toISOString();
    var parts = FIRESTORE_DOC.split('/');

    await db.collection(parts[0]).doc(parts[1]).set({
      S: state.S, S_SC: state.S_SC, S_TT: state.S_TT,
      headersData: state.headersData,
      enginLabels: state.enginLabels, enginLabels_SC: state.enginLabels_SC, enginLabels_TT: state.enginLabels_TT,
      synthCols: state.synthCols,
      colOrder: state.colOrder,
      rassemblement: state.rassemblement,
      customRoles: state.customRoles || [],
      removedRoles: state.removedRoles || [],
      dateJour: dateJour,
      savedAt: savedAt
    });
    lastLocalSavedAt = savedAt;

    if (dateJour && state.historique[dateJour]) {
      await db.collection('historique').doc(dateJour).set({
        ...state.historique[dateJour],
        updatedAt: savedAt
      });
    }

    await syncActions();

    var currentDates = Object.keys(state.historique);
    for (var i = 0; i < loadedHistDates.length; i++) {
      if (currentDates.indexOf(loadedHistDates[i]) === -1) {
        await db.collection('historique').doc(loadedHistDates[i]).delete();
      }
    }
    loadedHistDates = currentDates;

    dirty = false;
    setStatus('ok', '✓ Sauvegardé ' + new Date().toLocaleTimeString('fr-FR'));
  } catch (e) {
    setStatus('err', 'Erreur sauvegarde');
    console.error(e);
  }
}

async function syncActions() {
  var currentIds = {};
  state.actions.forEach(function (a) { if (a.id) currentIds[a.id] = true; });
  var ops = [];
  loadedActionIds.forEach(function (id) { if (!currentIds[id]) ops.push({ del: id }); });
  state.actions.forEach(function (a) { 
    if (a.id) ops.push({ set: { ...a, updatedAt: new Date().toISOString() } }); 
  });
  
  for (var s = 0; s < ops.length; s += 450) {
    var batch = db.batch();
    ops.slice(s, s + 450).forEach(function (op) {
      if (op.del) batch.delete(db.collection('actions').doc(op.del));
      else batch.set(db.collection('actions').doc(op.set.id), op.set);
    });
    await batch.commit();
  }
  loadedActionIds = Object.keys(currentIds);
}

function scheduleAutoSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () { saveFirebase(); }, 6000);
  setStatus('sync', 'Modifications en cours...');
}
onDirty(scheduleAutoSave);

export function loadLocal() {
  try {
    var bk = localStorage.getItem('sp_backup');
    if (!bk) return;
    var data = JSON.parse(bk);
    var patch = {};
    ['S', 'S_SC', 'S_TT', 'headersData', 'enginLabels', 'enginLabels_SC', 'enginLabels_TT', 'synthCols', 'historique', 'colOrder', 'rassemblement', 'actions'].forEach(function (k) {
      if (data[k] !== undefined) patch[k] = data[k];
    });
    setState(patch); ensureFullStructure();
    if (data.dateJour) document.getElementById('dateJour').value = data.dateJour;
  } catch (e) { console.error(e); }
}
