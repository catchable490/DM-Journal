import OBR from 'https://esm.sh/@owlbear-rodeo/sdk@2.3.2';
import { marked } from 'https://esm.sh/marked@12.0.0';

class OBRService {
  constructor() {
    this.isReady = false; this.isStandalone = false;
    this.party = [{ id: '1', name: 'Valdar' }, { id: '2', name: 'Lyra' }, { id: '3', name: 'Kaelen' }];
    this.init();
  }
  async init() {
    try {
      if (typeof window !== 'undefined' && window.location !== window.parent.location) {
        await OBR.onReady(async () => {
          this.isReady = true;
          this.updateParty();
          OBR.party.onChange(() => this.updateParty());
        });
      } else { this.isReady = true; this.isStandalone = true; }
    } catch (e) { this.isReady = true; this.isStandalone = true; }
  }
  async updateParty() {
    if (!this.isReady || this.isStandalone) return;
    try {
      const players = await OBR.party.getPlayers();
      this.party = players.map(p => ({ id: p.id, name: p.name || 'Player' }));
    } catch (e) {}
  }
  async checkIsGM() {
    if (this.isStandalone) return true;
    try { return (await OBR.player.getRole()) === 'GM'; } catch (e) { return true; }
  }
  async fetchSceneName() {
    if (this.isStandalone) return 'Shaboath';
    try {
      if (!(await OBR.scene.isReady())) return 'General Notes';
      const meta = await OBR.scene.getMetadata();
      return (meta && meta.name) ? meta.name : 'Shaboath';
    } catch (e) { return 'General Notes'; }
  }
  getPartyPlayers() { return this.party; }
  async saveData(str) {
    localStorage.setItem('obr_dm_journal_v1', str);
    if (!this.isStandalone && this.isReady) {
      try { await OBR.room.setMetadata({ 'com.antigravity.dm-journal/notes': str }); } catch (e) {}
    }
  }
  async loadData() {
    if (!this.isStandalone && this.isReady) {
      try {
        const meta = await OBR.room.getMetadata();
        if (meta && meta['com.antigravity.dm-journal/notes']) return meta['com.antigravity.dm-journal/notes'];
      } catch (e) {}
    }
    return localStorage.getItem('obr_dm_journal_v1');
  }
}

const obrService = new OBRService();

class JournalManager {
  constructor() {
    this.sessions = []; this.currentId = null;
    this.settings = { formatTags: true, formatPlayers: true, timestamps: true };
    this.onUpdate = null;
    this.load();
  }
  async load() {
    const raw = await obrService.loadData();
    if (raw) {
      try {
        const p = JSON.parse(raw);
        this.sessions = p.sessions || [];
        this.currentId = p.currentId || null;
      } catch (e) {}
    }
    const today = new Date().toISOString().split('T')[0];
    const cur = this.getCurrentSession();
    if (!cur || cur.date !== today) this.startSession(false);
  }
  async save() {
    await obrService.saveData(JSON.stringify({ sessions: this.sessions, currentId: this.currentId }));
  }
  getCurrentSession() { return this.sessions.find(s => s.id === this.currentId); }
  startSession(explicit = true) {
    const now = new Date();
    const players = obrService.getPartyPlayers().map(p => p.name);
    const newS = {
      id: 'session_' + Date.now(),
      date: now.toISOString().split('T')[0],
      formattedDate: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
      startTime: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      endTime: null,
      players: players.length > 0 ? players : ['Valdar', 'Lyra', 'Kaelen'],
      active: true,
      entries: []
    };
    this.sessions.forEach(s => s.active = false);
    this.sessions.unshift(newS);
    this.currentId = newS.id;
    if (explicit && this.onUpdate) this.onUpdate();
    this.save();
    return newS;
  }
  endSession() {
    const s = this.getCurrentSession();
    if (s) {
      s.endTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      s.active = false;
      if (this.onUpdate) this.onUpdate();
      this.save();
    }
  }
  async addNote(text) {
    const t = text.trim();
    if (!t) return { isCmd: false };
    if (t.toLowerCase() === '$start') { this.startSession(true); return { isCmd: true, name: '$start' }; }
    if (t.toLowerCase() === '$end') { this.endSession(); return { isCmd: true, name: '$end' }; }
    let s = this.getCurrentSession();
    if (!s) s = this.startSession(true);
    const scene = await obrService.fetchSceneName();
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    let formatted = t.replace(/#([a-zA-Z0-9_\-]+)/g, (_, tag) => `[[${tag}]]`);
    formatted = formatted.replace(/@([a-zA-Z0-9_\-]+)/g, (_, p) => `[[${p}]]`);
    s.entries.push({ id: 'e_' + Date.now(), scene, raw: t, formatted, timestamp });
    if (this.onUpdate) this.onUpdate();
    this.save();
    return { isCmd: false };
  }
  generateMarkdown(session) {
    const s = session || this.getCurrentSession();
    if (!s) return '# No Session Log\n';
    let md = `# Session Log - ${s.formattedDate}\n\n**Date**: ${s.date}\n**Start Time**: ${s.startTime}\n`;
    md += s.endTime ? `**End Time**: ${s.endTime}\n` : `**Status**: Active 🟢\n`;
    md += `**Players Present**: ${s.players.map(p => `[[${p}]]`).join(', ')}\n\n---\n\n`;
    if (s.entries.length === 0) return md + '*No notes yet. Press `J` or click Quick Note to add notes!*\n';
    const grouped = {};
    s.entries.forEach(e => { (grouped[e.scene] = grouped[e.scene] || []).push(e); });
    Object.keys(grouped).forEach(sc => {
      md += `## ${sc}\n`;
      grouped[sc].forEach(e => { md += `- [${e.timestamp}] ${e.formatted}\n`; });
      md += `\n`;
    });
    return md.trim();
  }
}

const journalManager = new JournalManager();

class QuickPopup {
  constructor() {
    this.isOpen = false;
    this.createDom();
    this.attachEvents();
  }
  createDom() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'quick-popup-overlay';
    this.overlay.innerHTML = `
      <div class="quick-popup-card">
        <div class="popup-header">
          <div class="popup-title">Quick Note (<span id="popup-scene" style="color:var(--accent-cyan)">Shaboath</span>)</div>
          <div class="popup-hints"><span class="hint-pill">Enter to save</span></div>
        </div>
        <div class="popup-input-wrapper">
          <input type="text" id="quick-input" class="popup-input" placeholder="Type note (e.g. @Valdar found #magic sword), $start or $end..." autocomplete="off"/>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlay);
    this.input = this.overlay.querySelector('#quick-input');
    this.sceneLabel = this.overlay.querySelector('#popup-scene');
  }
  attachEvents() {
    document.addEventListener('keydown', (e) => {
      const isInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if ((e.key === 'j' || e.key === 'J') && !isInput && !this.isOpen) {
        e.preventDefault(); this.open();
      } else if (e.key === 'Escape' && this.isOpen) { this.close(); }
    });
    this.input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await this.submit(); }
    });
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });
  }
  async open() {
    this.sceneLabel.textContent = await obrService.fetchSceneName();
    this.input.value = '';
    this.isOpen = true;
    this.overlay.classList.add('active');
    setTimeout(() => this.input.focus(), 50);
  }
  close() {
    this.isOpen = false;
    this.overlay.classList.remove('active');
    this.input.blur();
  }
  async submit() {
    const txt = this.input.value.trim();
    if (!txt) { this.close(); return; }
    await journalManager.addNote(txt);
    this.close();
    this.showToast('Note added!');
  }
  showToast(msg) {
    let box = document.querySelector('.toast-container');
    if (!box) { box = document.createElement('div'); box.className = 'toast-container'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'toast';
    t.innerHTML = `<span>${msg}</span>`; box.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }
}

class JournalHub {
  constructor(container, popup) {
    this.container = container; this.popup = popup;
    this.currentTab = 'preview';
    this.init();
  }
  async init() {
    journalManager.onUpdate = () => this.render();
    this.render();
  }
  render() {
    const cur = journalManager.getCurrentSession();
    const active = cur?.active ?? false;

    this.container.innerHTML = `
      <div class="journal-container">
        <div class="journal-header">
          <div class="brand-title">DM Journal</div>
          <div class="status-badge ${active ? '' : 'inactive'}">${active ? 'Session Active' : 'Ended'}</div>
        </div>

        <div class="hotkey-banner">
          <div class="hotkey-hint">Press <span class="kbd-badge">J</span> for quick note</div>
          <button id="btn-summon" class="btn-quick-summon">+ Quick Note</button>
        </div>

        <div class="scene-bar">
          <div class="scene-info">Scene: <span class="scene-name" id="sc-name">Shaboath</span></div>
          <div class="action-row">
            <button id="btn-start" class="btn-action">$start</button>
            <button id="btn-end" class="btn-action">$end</button>
            <button id="btn-copy" class="btn-action btn-copy">Copy Obsidian MD</button>
          </div>
        </div>

        <div class="nav-tabs">
          <button class="nav-tab ${this.currentTab === 'preview' ? 'active' : ''}" data-t="preview">Preview</button>
          <button class="nav-tab ${this.currentTab === 'raw' ? 'active' : ''}" data-t="raw">Raw Markdown</button>
          <button class="nav-tab ${this.currentTab === 'history' ? 'active' : ''}" data-t="history">History</button>
        </div>

        <div class="tab-content">
          <div class="content-pane ${this.currentTab === 'preview' ? 'active' : ''}">
            <div class="markdown-view">${this.renderPreview()}</div>
          </div>
          <div class="content-pane ${this.currentTab === 'raw' ? 'active' : ''}">
            <textarea class="raw-editor" readonly>${journalManager.generateMarkdown()}</textarea>
          </div>
          <div class="content-pane ${this.currentTab === 'history' ? 'active' : ''}">
            <div class="markdown-view">${this.renderHistory()}</div>
          </div>
        </div>
      </div>
    `;

    obrService.fetchSceneName().then(n => {
      const el = this.container.querySelector('#sc-name');
      if (el) el.textContent = n;
    });

    this.attach();
  }
  renderPreview() {
    const md = journalManager.generateMarkdown();
    const html = marked.parse(md);
    return html.replace(/\[\[(.*?)\]\]/g, (_, inText) => `<span class="obsidian-link">[[${inText}]]</span>`);
  }
  renderHistory() {
    const list = journalManager.sessions;
    if (list.length === 0) return '<p>No history</p>';
    return list.map(s => `
      <div style="background:var(--bg-card); padding:8px 12px; margin-bottom:6px; border-radius:6px; display:flex; justify-content:space-between;">
        <div><strong>${s.formattedDate}</strong> (${s.entries.length} notes)</div>
      </div>
    `).join('');
  }
  attach() {
    this.container.querySelector('#btn-summon')?.addEventListener('click', () => this.popup.open());
    this.container.querySelector('#btn-start')?.addEventListener('click', () => journalManager.addNote('$start'));
    this.container.querySelector('#btn-end')?.addEventListener('click', () => journalManager.addNote('$end'));
    this.container.querySelector('#btn-copy')?.addEventListener('click', () => {
      navigator.clipboard.writeText(journalManager.generateMarkdown());
      this.popup.showToast('Obsidian MD copied!');
    });
    this.container.querySelectorAll('.nav-tab').forEach(t => {
      t.addEventListener('click', e => {
        this.currentTab = e.currentTarget.getAttribute('data-t');
        this.render();
      });
    });
  }
}

async function main() {
  const isGM = await obrService.checkIsGM();
  const app = document.getElementById('app');
  if (!isGM) { app.innerHTML = '<div class="gm-guard"><h2>GM Only Tool</h2></div>'; return; }
  const popup = new QuickPopup();
  new JournalHub(app, popup);
}

main();
