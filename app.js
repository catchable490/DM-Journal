import OBR from 'https://esm.sh/@owlbear-rodeo/sdk@2.3.2';
import { marked } from 'https://esm.sh/marked@12.0.0';

// -------------------------------------------------------------
// OBR Service Wrapper
// -------------------------------------------------------------
class OBRService {
  constructor() {
    this.isReady = false;
    this.isStandalone = false;
    this.partyPlayers = [
      { id: '1', name: 'Valdar', role: 'PLAYER' },
      { id: '2', name: 'Lyra', role: 'PLAYER' },
      { id: '3', name: 'Kaelen', role: 'PLAYER' },
      { id: '4', name: 'Eldrin', role: 'PLAYER' }
    ];
    this.onPlayersChangeCallbacks = [];
    this.onSceneChangeCallbacks = [];
    this.init();
  }

  async init() {
    try {
      if (typeof window !== 'undefined' && window.location !== window.parent.location) {
        await OBR.onReady(async () => {
          this.isReady = true;
          this.isStandalone = false;
          this.updateParty();
          OBR.party.onChange(() => this.updateParty());
          OBR.scene.onReadyChange((ready) => {
            if (ready) {
              this.fetchSceneName().then(name => {
                this.onSceneChangeCallbacks.forEach(cb => cb(name));
              });
            }
          });
        });
      } else {
        this.enableStandalone();
      }
    } catch (e) {
      this.enableStandalone();
    }
  }

  enableStandalone() {
    this.isReady = true;
    this.isStandalone = true;
  }

  async updateParty() {
    if (!this.isReady || this.isStandalone) return;
    try {
      const players = await OBR.party.getPlayers();
      this.partyPlayers = players.map(p => ({
        id: p.id,
        name: p.name || 'Unnamed Player',
        role: p.role || 'PLAYER',
        color: p.color
      }));
      this.onPlayersChangeCallbacks.forEach(cb => cb(this.partyPlayers));
    } catch (e) {}
  }

  async checkIsGM() {
    if (this.isStandalone) return true;
    try {
      const role = await OBR.player.getRole();
      return role === 'GM';
    } catch (e) { return true; }
  }

  async fetchSceneName() {
    if (this.isStandalone) return 'Shaboath';
    try {
      const isReady = await OBR.scene.isReady();
      if (!isReady) return 'General Notes';
      const meta = await OBR.scene.getMetadata();
      if (meta && meta.name) return meta.name;
      return 'Shaboath';
    } catch (e) { return 'General Notes'; }
  }

  getPartyPlayers() { return this.partyPlayers; }
  onSceneChange(cb) { this.onSceneChangeCallbacks.push(cb); }

  async saveJournalData(jsonString) {
    localStorage.setItem('obr_dm_journal_data_v1', jsonString);
    if (!this.isStandalone && this.isReady) {
      try {
        await OBR.room.setMetadata({ 'com.antigravity.dm-journal/notes': jsonString });
      } catch (e) {}
    }
  }

  async loadJournalData() {
    if (!this.isStandalone && this.isReady) {
      try {
        const meta = await OBR.room.getMetadata();
        if (meta && meta['com.antigravity.dm-journal/notes']) {
          return meta['com.antigravity.dm-journal/notes'];
        }
      } catch (e) {}
    }
    return localStorage.getItem('obr_dm_journal_data_v1');
  }
}

const obrService = new OBRService();

// -------------------------------------------------------------
// Journal Manager & Obsidian Formatter
// -------------------------------------------------------------
class JournalManager {
  constructor() {
    this.sessions = [];
    this.currentSessionId = null;
    this.settings = { formatObsidianTags: true, formatObsidianPlayers: true, includeTimestamps: true };
    this.onUpdateCallbacks = null;
    this.load();
  }

  setOnUpdateCallback(cb) { this.onUpdateCallbacks = cb; }
  triggerUpdate() {
    this.save();
    if (this.onUpdateCallbacks) this.onUpdateCallbacks();
  }

  async load() {
    const data = await obrService.loadJournalData();
    if (data) {
      try {
        const parsed = JSON.parse(data);
        this.sessions = parsed.sessions || [];
        this.currentSessionId = parsed.currentSessionId || null;
        if (parsed.settings) this.settings = { ...this.settings, ...parsed.settings };
      } catch (e) {}
    }

    const today = this.getTodayDateString();
    let current = this.getCurrentSession();
    if (!current || current.date !== today) {
      this.startNewSession(false);
    }
  }

  async save() {
    const json = JSON.stringify({ sessions: this.sessions, currentSessionId: this.currentSessionId, settings: this.settings });
    await obrService.saveJournalData(json);
  }

  getTodayDateString() { return new Date().toISOString().split('T')[0]; }
  getFormattedDateString(d = new Date()) { return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
  getFormattedTimeString(d = new Date()) { return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); }

  getCurrentSession() { return this.sessions.find(s => s.id === this.currentSessionId); }
  getSessions() { return this.sessions; }
  getSettings() { return this.settings; }
  updateSettings(s) { this.settings = { ...this.settings, ...s }; this.triggerUpdate(); }

  startNewSession(explicit = true) {
    const now = new Date();
    const today = this.getTodayDateString();
    const players = obrService.getPartyPlayers().map(p => p.name);

    const newSession = {
      id: 'session_' + Date.now(),
      date: today,
      formattedDate: this.getFormattedDateString(now),
      startTime: this.getFormattedTimeString(now),
      endTime: null,
      playersPresent: players.length > 0 ? players : ['Valdar', 'Lyra', 'Kaelen'],
      active: true,
      entries: []
    };

    this.sessions.forEach(s => s.active = false);
    this.sessions.unshift(newSession);
    this.currentSessionId = newSession.id;
    if (explicit) this.triggerUpdate();
    return newSession;
  }

  endCurrentSession() {
    const session = this.getCurrentSession();
    if (!session) return;
    session.endTime = this.getFormattedTimeString();
    session.active = false;
    this.triggerUpdate();
    return session;
  }

  async addNote(text, sceneOverride) {
    const trimmed = text.trim();
    if (!trimmed) return { isCommand: false };

    if (trimmed.toLowerCase() === '$start') {
      this.startNewSession(true);
      return { isCommand: true, commandName: '$start' };
    }
    if (trimmed.toLowerCase() === '$end') {
      this.endCurrentSession();
      return { isCommand: true, commandName: '$end' };
    }

    let session = this.getCurrentSession();
    if (!session) session = this.startNewSession(true);

    const sceneName = sceneOverride || await obrService.fetchSceneName();
    const timestamp = this.getFormattedTimeString();
    const formattedText = this.formatNoteText(trimmed);

    session.entries.push({
      id: 'entry_' + Date.now(),
      sceneName,
      rawText: trimmed,
      formattedText,
      timestamp
    });

    this.triggerUpdate();
    return { isCommand: false };
  }

  formatNoteText(text) {
    let result = text;
    result = result.replace(/#([a-zA-Z0-9_\-]+)/g, (_, tag) => this.settings.formatObsidianTags ? `[[${tag}]]` : `#${tag}`);
    result = result.replace(/@([a-zA-Z0-9_\-]+)/g, (_, player) => {
      if (this.settings.formatObsidianPlayers) {
        const found = obrService.getPartyPlayers().find(p => p.name.toLowerCase() === player.toLowerCase());
        return `[[${found ? found.name : player}]]`;
      }
      return `@${player}`;
    });
    return result;
  }

  generateObsidianMarkdown(session) {
    const target = session || this.getCurrentSession();
    if (!target) return '# No Session Notes Found\n';

    let md = `# Session Log - ${target.formattedDate}\n\n`;
    md += `**Date**: ${target.date}\n`;
    md += `**Start Time**: ${target.startTime}\n`;
    md += target.endTime ? `**End Time**: ${target.endTime}\n` : `**Status**: In Progress 🟢\n`;
    const players = target.playersPresent.map(p => this.settings.formatObsidianPlayers ? `[[${p}]]` : `@${p}`).join(', ');
    md += `**Players Present**: ${players || 'None'}\n\n---\n\n`;

    if (target.entries.length === 0) {
      md += `*No notes recorded yet for this session. Press \`J\` to add a quick note!*\n`;
      return md;
    }

    const grouped = {};
    target.entries.forEach(e => {
      const sc = e.sceneName || 'General Notes';
      if (!grouped[sc]) grouped[sc] = [];
      grouped[sc].push(e);
    });

    Object.keys(grouped).forEach(sc => {
      md += `## ${sc}\n`;
      grouped[sc].forEach(e => {
        const timeStr = this.settings.includeTimestamps ? `[${e.timestamp}] ` : '';
        md += `- ${timeStr}${e.formattedText}\n`;
      });
      md += `\n`;
    });

    return md.trim();
  }

  getAllKnownTags() {
    const set = new Set();
    this.sessions.forEach(s => s.entries.forEach(e => {
      const matches = e.rawText.match(/#([a-zA-Z0-9_\-]+)/g);
      if (matches) matches.forEach(m => set.add(m.substring(1)));
    }));
    return Array.from(set);
  }
}

const journalManager = new JournalManager();

// -------------------------------------------------------------
// Quick Popup Component (J Hotkey)
// -------------------------------------------------------------
class QuickPopup {
  constructor() {
    this.isOpen = false;
    this.suggestions = [];
    this.activeIndex = -1;
    this.onNoteAdded = null;
    this.createDom();
    this.attachEvents();
  }

  createDom() {
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'quick-popup-overlay';
    this.overlayEl.innerHTML = `
      <div class="quick-popup-card">
        <div class="popup-header">
          <div class="popup-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            Quick Session Note <span style="font-size:0.75rem; font-weight:normal; opacity:0.7;">(Scene: <strong id="popup-scene-name" class="autocomplete-player">Loading...</strong>)</span>
          </div>
          <div class="popup-hints">
            <span class="hint-pill"><code>$</code> cmds</span>
            <span class="hint-pill"><code>@</code> player</span>
            <span class="hint-pill"><code>#</code> tag</span>
            <span class="hint-pill"><code>Enter</code> save</span>
          </div>
        </div>
        <div class="popup-input-wrapper">
          <input type="text" id="quick-note-input" class="popup-input" placeholder="Type note (e.g. @Valdar found #magic artifact), $start, or $end..." autocomplete="off"/>
          <div id="autocomplete-dropdown" class="autocomplete-dropdown"></div>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlayEl);
    this.inputEl = this.overlayEl.querySelector('#quick-note-input');
    this.dropdownEl = this.overlayEl.querySelector('#autocomplete-dropdown');
    this.sceneNameEl = this.overlayEl.querySelector('#popup-scene-name');
  }

  attachEvents() {
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.key === 'j' || e.key === 'J') && !isInput && !this.isOpen) {
        e.preventDefault();
        this.open();
      } else if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });

    this.inputEl.addEventListener('input', () => this.handleInput());
    this.inputEl.addEventListener('keydown', async (e) => {
      if (this.dropdownEl.classList.contains('active') && this.suggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.activeIndex = (this.activeIndex + 1) % this.suggestions.length;
          this.renderDropdown();
          return;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.activeIndex = (this.activeIndex - 1 + this.suggestions.length) % this.suggestions.length;
          this.renderDropdown();
          return;
        } else if (e.key === 'Enter' && this.activeIndex >= 0) {
          e.preventDefault();
          this.selectSuggestion(this.suggestions[this.activeIndex]);
          return;
        }
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        await this.submit();
      }
    });

    this.overlayEl.addEventListener('click', (e) => {
      if (e.target === this.overlayEl) this.close();
    });
  }

  async open() {
    const scene = await obrService.fetchSceneName();
    this.sceneNameEl.textContent = scene;
    this.inputEl.value = '';
    this.isOpen = true;
    this.overlayEl.classList.add('active');
    setTimeout(() => this.inputEl.focus(), 50);
  }

  close() {
    this.isOpen = false;
    this.overlayEl.classList.remove('active');
    this.dropdownEl.classList.remove('active');
    this.inputEl.blur();
  }

  handleInput() {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart || val.length;
    const words = val.substring(0, pos).split(/\s+/);
    const last = words[words.length - 1] || '';

    this.suggestions = [];
    this.activeIndex = -1;

    if (last.startsWith('$')) {
      const q = last.substring(1).toLowerCase();
      const cmds = [
        { label: '$start - Start/Reset new session note', value: '$start', type: 'cmd' },
        { label: '$end - End active session & log duration', value: '$end', type: 'cmd' }
      ];
      this.suggestions = cmds.filter(c => c.value.toLowerCase().includes(q));
    } else if (last.startsWith('@')) {
      const q = last.substring(1).toLowerCase();
      this.suggestions = obrService.getPartyPlayers()
        .filter(p => p.name.toLowerCase().includes(q))
        .map(p => ({ label: `@${p.name}`, value: `@${p.name}`, type: 'player' }));
    } else if (last.startsWith('#')) {
      const q = last.substring(1).toLowerCase();
      const defaults = ['combat', 'quest', 'npc', 'loot', 'location', 'lore', 'magic', 'puzzle'];
      const allTags = Array.from(new Set([...defaults, ...journalManager.getAllKnownTags()]));
      this.suggestions = allTags.filter(t => t.toLowerCase().includes(q)).map(t => ({ label: `#${t}`, value: `#${t}`, type: 'tag' }));
    }

    if (this.suggestions.length > 0) {
      this.activeIndex = 0;
      this.renderDropdown();
      this.dropdownEl.classList.add('active');
    } else {
      this.dropdownEl.classList.remove('active');
    }
  }

  renderDropdown() {
    this.dropdownEl.innerHTML = '';
    this.suggestions.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = `autocomplete-item ${index === this.activeIndex ? 'selected' : ''}`;
      let cls = 'autocomplete-tag';
      if (item.type === 'player') cls = 'autocomplete-player';
      if (item.type === 'cmd') cls = 'autocomplete-cmd';
      el.innerHTML = `<span class="${cls}">${item.label}</span>`;
      el.addEventListener('click', () => this.selectSuggestion(item));
      this.dropdownEl.appendChild(el);
    });
  }

  selectSuggestion(item) {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart || val.length;
    const words = val.substring(0, pos).split(/\s+/);
    words[words.length - 1] = item.value;
    this.inputEl.value = words.join(' ') + ' ' + val.substring(pos);
    this.dropdownEl.classList.remove('active');
    this.inputEl.focus();
  }

  async submit() {
    const text = this.inputEl.value.trim();
    if (!text) { this.close(); return; }

    const scene = await obrService.fetchSceneName();
    const res = await journalManager.addNote(text, scene);
    this.close();

    if (this.onNoteAdded) this.onNoteAdded();

    if (res.isCommand) {
      this.showToast(res.commandName === '$start' ? 'Session Started! New note created.' : 'Session Concluded! End timestamp logged.');
    } else {
      this.showToast(`Note added under "${scene}"!`);
    }
  }

  showToast(msg) {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }
}

// -------------------------------------------------------------
// Journal Hub Main View Component
// -------------------------------------------------------------
class JournalHub {
  constructor(container, quickPopup) {
    this.container = container;
    this.quickPopup = quickPopup;
    this.currentTab = 'preview';
    this.selectedHistoryId = null;
    this.sceneName = 'Shaboath';
    this.init();
  }

  async init() {
    this.sceneName = await obrService.fetchSceneName();
    obrService.onSceneChange(n => { this.sceneName = n; this.render(); });
    journalManager.setOnUpdateCallback(() => this.render());
    this.render();
  }

  render() {
    const current = this.getCurrentDisplaySession();
    const active = current?.active ?? false;

    this.container.innerHTML = `
      <div class="journal-container">
        <div class="journal-header">
          <div class="brand-title">
            <svg class="brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
            DM Journal
          </div>
          <div class="status-badge ${active ? '' : 'inactive'}">
            <span class="status-dot"></span>
            ${active ? 'Session Active' : 'Session Ended'}
          </div>
        </div>

        <div class="hotkey-banner">
          <div class="hotkey-hint">
            <span>Press</span>
            <span class="kbd-badge">J</span>
            <span>for quick note</span>
          </div>
          <button id="btn-summon-popup" class="btn-quick-summon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Quick Note
          </button>
        </div>

        <div class="scene-bar">
          <div class="scene-info">
            <span>Scene:</span>
            <span class="scene-name">${this.sceneName}</span>
          </div>
          <div class="action-row">
            <button id="btn-cmd-start" class="btn-action">$start</button>
            <button id="btn-cmd-end" class="btn-action">$end</button>
            <button id="btn-copy-obsidian" class="btn-action btn-copy">Copy Obsidian MD</button>
          </div>
        </div>

        <div class="nav-tabs">
          <button class="nav-tab ${this.currentTab === 'preview' ? 'active' : ''}" data-tab="preview">Preview</button>
          <button class="nav-tab ${this.currentTab === 'raw' ? 'active' : ''}" data-tab="raw">Raw Markdown</button>
          <button class="nav-tab ${this.currentTab === 'history' ? 'active' : ''}" data-tab="history">History</button>
          <button class="nav-tab ${this.currentTab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
        </div>

        <div class="tab-content">
          <div class="content-pane ${this.currentTab === 'preview' ? 'active' : ''}">
            <div class="markdown-view">${this.renderPreviewHtml()}</div>
          </div>
          <div class="content-pane ${this.currentTab === 'raw' ? 'active' : ''}">
            <textarea class="raw-editor" readonly>${journalManager.generateObsidianMarkdown(current)}</textarea>
          </div>
          <div class="content-pane ${this.currentTab === 'history' ? 'active' : ''}">
            <div class="markdown-view">
              <h2 style="margin-top:0; color:#fff">Past Sessions</h2>
              ${this.renderHistory()}
            </div>
          </div>
          <div class="content-pane ${this.currentTab === 'settings' ? 'active' : ''}">
            <div class="markdown-view">
              <h2 style="margin-top:0; color:#fff">Obsidian Settings</h2>
              <div style="display:flex; flex-direction:column; gap:12px; margin-top:10px;">
                <label style="cursor:pointer"><input type="checkbox" id="chk-tags" ${journalManager.getSettings().formatObsidianTags ? 'checked' : ''}> Convert #Tag to [[Tag]]</label>
                <label style="cursor:pointer"><input type="checkbox" id="chk-players" ${journalManager.getSettings().formatObsidianPlayers ? 'checked' : ''}> Convert @Player to [[PlayerName]]</label>
                <label style="cursor:pointer"><input type="checkbox" id="chk-timestamps" ${journalManager.getSettings().includeTimestamps ? 'checked' : ''}> Include Timestamps</label>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.attachEvents();
  }

  getCurrentDisplaySession() {
    if (this.selectedHistoryId) {
      const found = journalManager.getSessions().find(s => s.id === this.selectedHistoryId);
      if (found) return found;
    }
    return journalManager.getCurrentSession();
  }

  renderPreviewHtml() {
    const session = this.getCurrentDisplaySession();
    const md = journalManager.generateObsidianMarkdown(session);
    let html = marked.parse(md);
    return html.replace(/\[\[(.*?)\]\]/g, (_, inner) => inner.startsWith('#') ? `<span class="obsidian-tag">${inner}</span>` : `<span class="obsidian-link">[[${inner}]]</span>`);
  }

  renderHistory() {
    const sessions = journalManager.getSessions();
    if (sessions.length === 0) return '<p style="color:var(--text-muted)">No history</p>';
    return sessions.map(s => `
      <div style="background:var(--bg-card); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:10px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; cursor:pointer;" data-history-id="${s.id}">
        <div>
          <strong style="color:#fff">${s.formattedDate}</strong>
          <div style="font-size:0.75rem; color:var(--text-secondary)">${s.entries.length} notes | ${s.startTime}</div>
        </div>
        <button class="btn-action" style="font-size:0.75rem;">View</button>
      </div>
    `).join('');
  }

  attachEvents() {
    this.container.querySelector('#btn-summon-popup')?.addEventListener('click', () => this.quickPopup.open());
    this.container.querySelector('#btn-cmd-start')?.addEventListener('click', async () => {
      await journalManager.addNote('$start');
    });
    this.container.querySelector('#btn-cmd-end')?.addEventListener('click', async () => {
      await journalManager.addNote('$end');
    });
    this.container.querySelector('#btn-copy-obsidian')?.addEventListener('click', () => {
      const md = journalManager.generateObsidianMarkdown(this.getCurrentDisplaySession());
      navigator.clipboard.writeText(md);
      this.quickPopup.showToast('Obsidian Markdown copied!');
    });

    this.container.querySelectorAll('.nav-tab').forEach(t => {
      t.addEventListener('click', e => {
        this.currentTab = e.currentTarget.getAttribute('data-tab');
        this.render();
      });
    });

    this.container.querySelectorAll('[data-history-id]').forEach(card => {
      card.addEventListener('click', e => {
        this.selectedHistoryId = e.currentTarget.getAttribute('data-history-id');
        this.currentTab = 'preview';
        this.render();
      });
    });

    this.container.querySelector('#chk-tags')?.addEventListener('change', e => journalManager.updateSettings({ formatObsidianTags: e.target.checked }));
    this.container.querySelector('#chk-players')?.addEventListener('change', e => journalManager.updateSettings({ formatObsidianPlayers: e.target.checked }));
    this.container.querySelector('#chk-timestamps')?.addEventListener('change', e => journalManager.updateSettings({ includeTimestamps: e.target.checked }));
  }
}

// App Bootstrap
async function main() {
  const isGM = await obrService.checkIsGM();
  const app = document.getElementById('app');
  if (!isGM) {
    app.innerHTML = `<div class="gm-guard"><h2>GM Only Tool</h2><p>This extension is for Game Masters.</p></div>`;
    return;
  }

  const quickPopup = new QuickPopup();
  const journalHub = new JournalHub(app, quickPopup);
  quickPopup.onNoteAdded = () => journalHub.render();
}

main();
