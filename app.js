/* JSON Formatter & Minifier — client-side only, no network */
(function () {
  'use strict';

  // ---------- element refs ----------
  const $ = (id) => document.getElementById(id);
  const input = $('input');
  const highlight = $('highlight');
  const highlightCode = $('highlightCode');
  const gutter = $('gutter');
  const tree = $('tree');
  const editArea = $('editArea');
  const statusMsg = $('statusMsg');
  const charCount = $('charCount');
  const lineCount = $('lineCount');
  const cursorPos = $('cursorPos');
  const emptyHint = $('emptyHint');
  const toastEl = $('toast');
  const fixLayerInner = $('fixLayerInner');

  const themeToggle = $('themeToggle');
  const sampleBtn = $('sampleBtn');
  const clearBtn = $('clearBtn');
  const minifyLeftBtn = $('minifyLeftBtn');
  const copyInBtn = $('copyInBtn');
  const downloadInBtn = $('downloadInBtn');
  const formatBtn = $('formatBtn');
  const editToggle = $('editToggle');
  const collapseAllBtn = $('collapseAllBtn');
  const expandAllBtn = $('expandAllBtn');
  const copyOutBtn = $('copyOutBtn');
  const downloadOutBtn = $('downloadOutBtn');
  const minifyBtn = $('minifyBtn');

  let errorLine = 0;
  let lastFormatted = '';
  let mode = 'tree';
  let parseTimer = null;
  let fixMap = new Map();
  let fixMarks = [];
  let fixLines = new Set();

  // ---------- helpers ----------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function pathKey(p) { return p.join('\u0000'); }
  function lineOf(text, pos) { return text.slice(0, Math.max(0, pos || 0)).split('\n').length; }
  function colOf(text, pos) {
    const p = Math.max(0, pos || 0);
    const lineStart = text.lastIndexOf('\n', p - 1) + 1;
    return text.slice(lineStart, p).replace(/\t/g, '  ').length + 1;
  }

  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.style.background = isErr ? 'var(--danger)' : 'var(--text)';
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2000);
  }

  function setStatus(msg, kind) {
    statusMsg.textContent = msg;
    statusMsg.className = 'status-msg' + (kind ? ' ' + kind : '');
  }

  // ---------- theme ----------
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const dark = t === 'dark';
    themeToggle.querySelector('.theme-icon').textContent = dark ? '☀️' : '🌙';
    themeToggle.querySelector('.theme-label').textContent = dark ? 'Light' : 'Dark';
    try { localStorage.setItem('jsonfmt-theme', t); } catch (e) {}
  }
  (function initTheme() {
    let t = 'light';
    try { t = localStorage.getItem('jsonfmt-theme') || 'light'; } catch (e) {}
    applyTheme(t);
  })();
  themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  // ---------- syntax highlight (line based) ----------
  function highlightLine(line) {
    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      if (c === '"' || c === "'") {
        const q = c;
        let j = i + 1;
        let str = c;
        while (j < n) {
          if (line[j] === '\\') { str += line[j]; if (j + 1 < n) { str += line[j + 1]; j += 2; continue; } j++; break; }
          else if (line[j] === q) { str += line[j]; j++; break; }
          else { str += line[j]; j++; }
        }
        let k = j;
        while (k < n && /\s/.test(line[k])) k++;
        if (line[k] === ':') out += '<span class="tk-key">' + esc(str) + '</span>';
        else out += '<span class="tk-str">' + esc(str) + '</span>';
        i = j;
      } else if (c === '-' || (c >= '0' && c <= '9')) {
        let j = i; let num = '';
        if (c === '-') { num += '-'; j++; }
        while (j < n && /[0-9.eE+-]/.test(line[j])) { num += line[j]; j++; }
        out += '<span class="tk-num">' + esc(num) + '</span>';
        i = j;
      } else if (line.startsWith('true', i) || line.startsWith('false', i) || line.startsWith('null', i)) {
        const kw = line.startsWith('true', i) ? 'true' : line.startsWith('false', i) ? 'false' : 'null';
        out += '<span class="tk-bool">' + kw + '</span>';
        i += kw.length;
      } else if ('{}[],:'.includes(c)) {
        out += '<span class="tk-punct">' + esc(c) + '</span>'; i++;
      } else {
        out += esc(c); i++;
      }
    }
    return out;
  }

  function renderEditor() {
    const text = input.value;
    const lines = text.length ? text.split('\n') : [''];
    const total = lines.length;
    if (errorLine > total) errorLine = total;

    highlightCode.innerHTML = lines.map((ln, idx) => {
      const n = idx + 1;
      const cls = (n === errorLine) ? 'hl-line err' : 'hl-line';
      return '<div class="' + cls + '">' + highlightLine(ln) + '</div>';
    }).join('');

    gutter.innerHTML = lines.map((_, idx) => {
      const n = idx + 1;
      let cls = 'ln';
      if (n === errorLine) cls += ' err';
      else if (fixLines.has(n)) cls += ' fix';
      return '<div class="' + cls + '">' + n + '</div>';
    }).join('');

    charCount.textContent = text.length;
    lineCount.textContent = total;
    renderFixLayer();
    updateCursor();
  }

  // ---------- left-side precise fix markers ----------
  function renderFixLayer() {
    if (!fixLayerInner) return;
    fixLayerInner.innerHTML = '';
    fixMarks.forEach((m) => {
      const col = m.col - 1;
      const row = m.line - 1;
      const caret = document.createElement('span');
      caret.className = 'fix-caret';
      caret.textContent = '\u25BE';
      caret.style.left = 'calc(var(--pad-x) + ' + col + 'ch)';
      caret.style.top = 'calc(var(--pad-y) + var(--line-h) * ' + row + ' - 9px)';
      fixLayerInner.appendChild(caret);

      const tick = document.createElement('span');
      tick.className = 'fix-tick';
      tick.style.left = 'calc(var(--pad-x) + ' + col + 'ch)';
      tick.style.top = 'calc(var(--pad-y) + var(--line-h) * ' + row + ' + var(--line-h) - 2px)';
      fixLayerInner.appendChild(tick);
    });
    syncFixLayer();
  }

  function syncFixLayer() {
    if (!fixLayerInner) return;
    fixLayerInner.style.transform = 'translate(' + (-input.scrollLeft) + 'px,' + (-input.scrollTop) + 'px)';
  }

  function markErrorLine(line) { errorLine = line || 0; renderEditor(); }

  // ---------- cursor position ----------
  function updateCursor() {
    if (!cursorPos) return;
    const pos = input.selectionStart || 0;
    const before = input.value.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    cursorPos.textContent = 'Ln ' + line + ', Col ' + col;
  }

  // ---------- lenient (auto-repair) parser ----------
  function lenientParse(text) {
    const fixes = [];
    let i = 0;
    const n = text.length;
    let failed = false;
    let failMsg = '';

    function addFix(type, path, message, at) {
      fixes.push({ type: type, path: path.slice(), message: message, pos: (typeof at === 'number' ? at : i) });
    }

    function skipWs(path) {
      while (i < n) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u00a0' || c === '\ufeff') { i++; continue; }
        if (c === '/' && text[i + 1] === '/') {
          while (i < n && text[i] !== '\n') i++;
          addFix('comment', path, 'Removed line comment');
          continue;
        }
        if (c === '/' && text[i + 1] === '*') {
          i += 2;
          while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
          i += 2;
          addFix('comment', path, 'Removed block comment');
          continue;
        }
        break;
      }
    }

    function parseString(path) {
      const quote = text[i];
      i++;
      let out = '';
      while (i < n) {
        const c = text[i];
        if (c === '\\') {
          const e = text[i + 1];
          i += 2;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'u') { const hex = text.slice(i, i + 4); out += String.fromCharCode(parseInt(hex, 16) || 0); i += 4; }
          else out += (e === undefined ? '' : e);
          continue;
        }
        if (c === quote) { i++; return out; }
        out += c; i++;
      }
      addFix('unterminated', path, 'Closed unterminated string');
      return out;
    }

    function parseNumber(path) {
      const start = i;
      if (text[i] === '+' ) i++;
      if (text[i] === '-') i++;
      while (i < n && /[0-9.eE+\-]/.test(text[i])) i++;
      const raw = text.slice(start, i);
      let num = Number(raw);
      if (isNaN(num)) { addFix('bad-number', path, 'Fixed invalid number "' + raw + '"'); num = 0; }
      return num;
    }

    function parseValue(path) {
      skipWs(path);
      if (i >= n) { failed = true; failMsg = 'Unexpected end of input'; return null; }
      const c = text[i];
      if (c === '{') return parseObject(path);
      if (c === '[') return parseArray(path);
      if (c === '"') return parseString(path);
      if (c === "'") { addFix('single-quote', path, 'Converted single quotes to double quotes'); return parseString(path); }
      if (c === '-' || c === '+' || (c >= '0' && c <= '9')) return parseNumber(path);
      if (text.startsWith('true', i)) { i += 4; return true; }
      if (text.startsWith('false', i)) { i += 5; return false; }
      if (text.startsWith('null', i)) { i += 4; return null; }
      if (text.startsWith('undefined', i)) { i += 9; addFix('unquoted-value', path, 'Replaced "undefined" with null'); return null; }
      if (text.startsWith('NaN', i)) { i += 3; addFix('unquoted-value', path, 'Replaced "NaN" with null'); return null; }
      if (/[A-Za-z_$]/.test(c)) {
        const start = i;
        while (i < n && !/[,}\]\s:]/.test(text[i])) i++;
        const word = text.slice(start, i);
        addFix('unquoted-value', path, 'Quoted bare value "' + word + '"');
        return word;
      }
      failed = true; failMsg = 'Unexpected character "' + c + '"';
      return null;
    }

    function parseObject(path) {
      const obj = {};
      i++;
      skipWs(path);
      if (text[i] === '}') { i++; return obj; }
      while (i < n) {
        skipWs(path);
        if (text[i] === '}') { i++; return obj; }
        if (text[i] === undefined) break;
        if (text[i] === ',') { addFix('duplicate-comma', path, 'Removed extra comma'); i++; continue; }
        let key = null;
        const kc = text[i];
        const atKey = i;
        const singleKey = (kc === "'");
        if (kc === '"' || kc === "'") {
          key = parseString(path);
          if (singleKey) addFix('single-quote', path.concat(key), 'Converted single quotes to double quotes', atKey);
        } else if (/[A-Za-z0-9_$]/.test(kc)) {
          const start = i;
          while (i < n && !/[:\s,}\]]/.test(text[i])) i++;
          key = text.slice(start, i);
          addFix('unquoted-key', path.concat(key), 'Added quotes to key "' + key + '"', start);
        } else {
          failed = true; failMsg = 'Unexpected character "' + kc + '" in object';
          return obj;
        }
        skipWs(path);
        if (text[i] === ':') { i++; }
        else { addFix('missing-colon', path.concat(key), 'Inserted ":" after key "' + key + '"'); }
        obj[key] = parseValue(path.concat(key));
        skipWs(path);
        const c = text[i];
        if (c === ',') {
          i++; skipWs(path);
          if (text[i] === '}') { addFix('trailing-comma', path.concat(key), 'Removed trailing comma'); i++; return obj; }
          while (text[i] === ',') { addFix('duplicate-comma', path.concat(key), 'Removed extra comma'); i++; }
          continue;
        } else if (c === '}') { i++; return obj; }
        else if (c === undefined) { addFix('unterminated', path, 'Added missing "}"'); return obj; }
        else { addFix('missing-comma', path.concat(key), 'Inserted missing comma'); continue; }
      }
      addFix('unterminated', path, 'Added missing "}"');
      return obj;
    }

    function parseArray(path) {
      const arr = [];
      i++;
      skipWs(path);
      if (text[i] === ']') { i++; return arr; }
      let idx = 0;
      while (i < n) {
        skipWs(path);
        if (text[i] === ']') { i++; return arr; }
        if (text[i] === undefined) break;
        if (text[i] === ',') { addFix('duplicate-comma', idx > 0 ? path.concat(idx - 1) : path, 'Removed extra comma'); while (text[i] === ',') i++; continue; }
        arr.push(parseValue(path.concat(idx)));
        idx++;
        skipWs(path);
        const c = text[i];
        if (c === ',') {
          i++; skipWs(path);
          if (text[i] === ']') { addFix('trailing-comma', path.concat(idx - 1), 'Removed trailing comma'); i++; return arr; }
          continue;
        } else if (c === ']') { i++; return arr; }
        else if (c === undefined) { addFix('unterminated', path, 'Added missing "]"'); return arr; }
        else { addFix('missing-comma', path.concat(idx - 1), 'Inserted missing comma'); continue; }
      }
      addFix('unterminated', path, 'Added missing "]"');
      return arr;
    }

    skipWs([]);
    const value = parseValue([]);
    skipWs([]);
    if (!failed && i < n) addFix('trailing-garbage', [], 'Ignored trailing content');
    if (failed) return { ok: false, error: { msg: failMsg } };
    return { ok: true, value: value, fixes: fixes };
  }

  // strict first, then lenient auto-repair
  function parseJSONLoose(text) {
    try {
      return { ok: true, value: JSON.parse(text), fixes: [] };
    } catch (e) {
      return lenientParse(text);
    }
  }

  // strict parse just for error messages
  function parseJSON(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      let line = 0, col = 0;
      const msg = e && e.message ? e.message : 'Invalid JSON';
      const mPos = msg.match(/position (\d+)/);
      if (mPos) {
        const pos = parseInt(mPos[1], 10);
        const before = text.slice(0, pos);
        line = before.split('\n').length;
        col = pos - before.lastIndexOf('\n');
      } else {
        const mLC = msg.match(/line (\d+) column (\d+)/i);
        if (mLC) { line = parseInt(mLC[1], 10); col = parseInt(mLC[2], 10); }
      }
      return { ok: false, error: { line: line, col: col, msg: msg } };
    }
  }

  function cleanMsg(msg) {
    return msg
      .replace(/ in JSON at position \d+/, '')
      .replace(/^JSON\.parse:\s*/, '');
  }

  function countKeys(v) {
    let c = 0;
    (function walk(x) {
      if (x && typeof x === 'object') {
        if (Array.isArray(x)) x.forEach(walk);
        else { c += Object.keys(x).length; Object.values(x).forEach(walk); }
      }
    })(v);
    return c;
  }

  // ---------- tree render ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function span(cls, text) { return el('span', cls, text); }

  // map a fix record to the red token that should be shown inline
  function fixSpec(f) {
    const t = f.type;
    const m = f.message || '';
    if (t === 'missing-comma') return { tok: ',', mode: 'add' };
    if (t === 'trailing-comma') return { tok: ',', mode: 'remove' };
    if (t === 'duplicate-comma') return { tok: ',', mode: 'remove' };
    if (t === 'missing-colon') return { tok: ':', mode: 'add' };
    if (t === 'single-quote') return { tok: '"', mode: 'add' };
    if (t === 'unquoted-key') return { tok: '"', mode: 'add' };
    if (t === 'unquoted-value') return { tok: /\bnull\b/i.test(m) ? 'null' : '"', mode: 'add' };
    if (t === 'unterminated') {
      if (/string/i.test(m)) return { tok: '"', mode: 'add' };
      return { tok: m.indexOf(']') !== -1 ? ']' : '}', mode: 'add' };
    }
    if (t === 'comment') return { tok: '//', mode: 'remove' };
    if (t === 'bad-number') return { tok: '0', mode: 'add' };
    if (t === 'trailing-garbage') return { tok: '\u2026', mode: 'remove' };
    return { tok: '!', mode: 'add' };
  }

  function applyFix(node, path, target) {
    const fx = fixMap.get(pathKey(path));
    if (!fx || !fx.length) return;
    node.classList.add('has-fix');
    const host = target || node;
    const tips = [];
    fx.forEach((f) => {
      tips.push(f.message);
      const spec = fixSpec(f);
      const s = el('span', 'fix-token' + (spec.mode === 'remove' ? ' fix-remove' : ''), spec.tok);
      s.title = f.message;
      host.appendChild(s);
    });
    node.title = 'Auto-fixed:\n\u2022 ' + tips.join('\n\u2022 ');
  }

  function renderValue(value, path) {
    if (value === null) return span('tk-bool', 'null');
    const t = typeof value;
    if (t === 'object') {
      return Array.isArray(value) ? renderArray(value, undefined, false, path) : renderObject(value, undefined, false, path);
    }
    if (t === 'string') return span('tk-str', JSON.stringify(value));
    if (t === 'number') return span('tk-num', String(value));
    if (t === 'boolean') return span('tk-bool', String(value));
    return span('', String(value));
  }

  function labelParts(keyName) {
    const d = el('div');
    d.appendChild(span('tk-key', JSON.stringify(keyName)));
    d.appendChild(span('tk-punct', ': '));
    return d;
  }

  function makeNode(openCh, closeCh, label, body, previewText, trailingComma, path) {
    const wrap = el('div', 'jnode');
    const head = el('div', 'jhead');
    if (label) label.childNodes.forEach((c) => head.appendChild(c.cloneNode(true)));
    const tg = el('span', 'toggle', '▼');
    head.appendChild(tg);
    head.appendChild(span('tk-punct', openCh));
    const prev = el('span', 'jpreview', ' … ' + previewText + ' ');
    prev.style.display = 'none';
    head.appendChild(prev);
    wrap.appendChild(head);

    const b = el('div', 'jbody');
    body.forEach((child) => b.appendChild(child));
    wrap.appendChild(b);

    const foot = el('div', 'jfoot');
    foot.appendChild(span('tk-punct', closeCh));
    if (trailingComma) foot.appendChild(span('tk-punct', ','));
    wrap.appendChild(foot);

    applyFix(wrap, path, foot);
    tg.addEventListener('click', () => {
      const collapsed = wrap.classList.toggle('collapsed');
      tg.textContent = collapsed ? '▶' : '▼';
      prev.style.display = collapsed ? 'inline' : 'none';
    });
    return wrap;
  }

  function scalarRow(keyName, value, trailingComma, path) {
    const row = el('div', 'jrow');
    if (keyName !== undefined) {
      row.appendChild(span('tk-key', JSON.stringify(keyName)));
      row.appendChild(span('tk-punct', ': '));
    }
    row.appendChild(renderValue(value, path));
    if (trailingComma) row.appendChild(span('tk-punct', ','));
    applyFix(row, path);
    return row;
  }

  function renderObject(obj, keyName, trailingComma, path) {
    const keys = Object.keys(obj);
    const label = keyName !== undefined ? labelParts(keyName) : null;
    if (keys.length === 0) return emptyRow('{ }', keyName, trailingComma, path);

    const body = [];
    keys.forEach((k, idx) => {
      const last = idx === keys.length - 1;
      const v = obj[k];
      const cpath = path.concat(k);
      if (v !== null && typeof v === 'object') {
        body.push(Array.isArray(v) ? renderArray(v, k, !last, cpath) : renderObject(v, k, !last, cpath));
      } else {
        body.push(scalarRow(k, v, !last, cpath));
      }
    });
    return makeNode('{', '}', label, body, keys.length + ' ' + (keys.length === 1 ? 'key' : 'keys'), trailingComma, path);
  }

  function renderArray(arr, keyName, trailingComma, path) {
    const label = keyName !== undefined ? labelParts(keyName) : null;
    if (arr.length === 0) return emptyRow('[ ]', keyName, trailingComma, path);

    const body = [];
    arr.forEach((item, idx) => {
      const last = idx === arr.length - 1;
      const cpath = path.concat(idx);
      if (item !== null && typeof item === 'object') {
        body.push(Array.isArray(item) ? renderArray(item, undefined, !last, cpath) : renderObject(item, undefined, !last, cpath));
      } else {
        body.push(scalarRow(undefined, item, !last, cpath));
      }
    });
    return makeNode('[', ']', label, body, arr.length + ' ' + (arr.length === 1 ? 'item' : 'items'), trailingComma, path);
  }

  function emptyRow(braces, keyName, trailingComma, path) {
    const row = el('div', 'jrow');
    if (keyName !== undefined) {
      row.appendChild(span('tk-key', JSON.stringify(keyName)));
      row.appendChild(span('tk-punct', ': '));
    }
    row.appendChild(span('tk-punct', braces));
    if (trailingComma) row.appendChild(span('tk-punct', ','));
    applyFix(row, path);
    return row;
  }

  function renderTree(value, fixes) {
    fixMap = new Map();
    (fixes || []).forEach((f) => {
      const k = pathKey(f.path);
      if (!fixMap.has(k)) fixMap.set(k, []);
      fixMap.get(k).push(f);
    });
    tree.innerHTML = '';
    tree.appendChild(renderValue(value, []));
  }

  // ---------- view modes ----------
  function showTree() {
    mode = 'tree';
    tree.hidden = false;
    editArea.hidden = true;
    minifyBtn.hidden = true;
    editToggle.hidden = false;
    editToggle.textContent = 'Edit';
    collapseAllBtn.hidden = false;
    expandAllBtn.hidden = false;
    emptyHint.hidden = tree.childNodes.length > 0;
  }
  function showEdit() {
    mode = 'edit';
    if (!editArea.value.trim() && lastFormatted) editArea.value = lastFormatted;
    tree.hidden = true;
    editArea.hidden = false;
    minifyBtn.hidden = false;
    editToggle.textContent = 'Tree';
    collapseAllBtn.hidden = true;
    expandAllBtn.hidden = true;
    emptyHint.hidden = true;
  }

  // ---------- core actions ----------
  function runFormat() {
    const text = input.value;
    if (text.trim() === '') {
      tree.innerHTML = '';
      errorLine = 0;
      fixMarks = [];
      fixLines = new Set();
      renderEditor();
      setStatus('Empty input — paste some JSON.', '');
      emptyHint.hidden = false;
      return;
    }
    const res = parseJSONLoose(text);
    if (res.ok) {
      lastFormatted = JSON.stringify(res.value, null, 2);
      renderTree(res.value, res.fixes);
      showTree();
      errorLine = 0;
      fixMarks = [];
      fixLines = new Set();
      (res.fixes || []).forEach((f) => {
        if (typeof f.pos === 'number') {
          const ln = lineOf(text, f.pos);
          fixLines.add(ln);
          fixMarks.push({ line: ln, col: colOf(text, f.pos), type: f.type });
        }
      });
      renderEditor();
      const fx = res.fixes ? res.fixes.length : 0;
      if (fx > 0) {
        setStatus('Auto-repaired ' + fx + ' issue' + (fx > 1 ? 's' : '') + ' — red marks show what was fixed.', 'warn');
      } else {
        setStatus('Valid JSON — ' + countKeys(res.value) + ' keys formatted.', 'ok');
      }
    } else {
      fixMarks = [];
      fixLines = new Set();
      const e = parseJSON(text);
      const err = (e.ok ? null : e.error) || { line: 0, col: 0, msg: (res.error && res.error.msg) || 'Invalid JSON' };
      markErrorLine(err.line);
      const at = err.line ? 'line ' + err.line + (err.col ? ', col ' + err.col : '') : '';
      setStatus('Invalid JSON' + (at ? ' at ' + at : '') + ': ' + cleanMsg(err.msg), 'err');
    }
  }

  function runMinifyLeft() {
    const text = input.value;
    if (!text.trim()) { toast('Nothing to minify', true); return; }
    const res = parseJSONLoose(text);
    if (res.ok) {
      const before = text.length;
      input.value = JSON.stringify(res.value);
      renderEditor();
      runFormat();
      input.focus();
      toast('Minified: ' + before + ' → ' + input.value.length + ' chars');
    } else {
      toast('Cannot minify — JSON looks broken', true);
    }
  }

  function runMinify() {
    const text = editArea.value;
    const res = parseJSONLoose(text);
    if (res.ok) {
      input.value = JSON.stringify(res.value);
      renderEditor();
      runFormat();
      toast('Minified to input →');
    } else {
      toast('Cannot minify — invalid JSON in editor', true);
    }
  }

  function setAllCollapsed(c) {
    tree.querySelectorAll('.jnode').forEach((node) => {
      const tg = node.querySelector('.toggle');
      const prev = node.querySelector('.jpreview');
      if (!tg) return;
      if (c && !node.classList.contains('collapsed')) {
        node.classList.add('collapsed'); tg.textContent = '▶'; if (prev) prev.style.display = 'inline';
      } else if (!c && node.classList.contains('collapsed')) {
        node.classList.remove('collapsed'); tg.textContent = '▼'; if (prev) prev.style.display = 'none';
      }
    });
  }

  // ---------- copy / download ----------
  function copyText(text) {
    if (!text) { toast('Nothing to copy', true); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard')).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard'); }
    catch (e) { toast('Copy failed', true); }
    document.body.removeChild(ta);
  }
  function downloadText(text, name) {
    if (!text) { toast('Nothing to download', true); return; }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- sample ----------
  const SAMPLE = {
    name: 'JSON Formatter',
    version: 1.0,
    active: true,
    tags: ['format', 'validate', 'minify'],
    author: { name: 'Li', city: 'Ningbo', social: null },
    features: [
      { id: 1, label: 'Foldable tree' },
      { id: 2, label: 'Error highlight' },
      { id: 3, label: 'Auto-fix' }
    ],
    note: 'Edit on the left, fold on the right.'
  };

  // ---------- events ----------
  input.addEventListener('input', () => {
    renderEditor();
    clearTimeout(parseTimer);
    parseTimer = setTimeout(runFormat, 250);
  });
  input.addEventListener('scroll', () => {
    highlight.scrollTop = input.scrollTop;
    highlight.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
    syncFixLayer();
  });
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runFormat(); }
  });
  ['keyup', 'click', 'input'].forEach((ev) => input.addEventListener(ev, updateCursor));
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === input) updateCursor();
  });

  editArea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runMinify(); }
  });

  formatBtn.addEventListener('click', runFormat);
  minifyLeftBtn.addEventListener('click', runMinifyLeft);
  minifyBtn.addEventListener('click', runMinify);
  editToggle.addEventListener('click', () => { if (mode === 'tree') showEdit(); else showTree(); });
  collapseAllBtn.addEventListener('click', () => setAllCollapsed(true));
  expandAllBtn.addEventListener('click', () => setAllCollapsed(false));

  sampleBtn.addEventListener('click', () => {
    input.value = JSON.stringify(SAMPLE, null, 2);
    renderEditor();
    runFormat();
    toast('Sample loaded');
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    tree.innerHTML = '';
    errorLine = 0;
    fixMarks = [];
    fixLines = new Set();
    renderEditor();
    setStatus('Cleared.', '');
    emptyHint.hidden = false;
  });

  copyInBtn.addEventListener('click', () => copyText(input.value));
  copyOutBtn.addEventListener('click', () => copyText(mode === 'edit' ? editArea.value : lastFormatted));
  downloadInBtn.addEventListener('click', () => downloadText(input.value, 'input.json'));
  downloadOutBtn.addEventListener('click', () => downloadText(mode === 'edit' ? editArea.value : lastFormatted, 'output.json'));

  // ---------- self test (?selftest=1) ----------
  function runSelfTest() {
    const cases = [
      { name: 'trailing comma', input: '{"a":1,}' },
      { name: 'missing comma', input: '{"a":1 "b":2}' },
      { name: 'single quotes', input: "{'a':'x'}" },
      { name: 'unquoted key', input: '{a:1, b:2}' },
      { name: 'double comma', input: '[1,,2]' },
      { name: 'bare value', input: '{a:hello}' },
      { name: 'line comment', input: '{"a":1} // note' },
      { name: 'unterminated obj', input: '{"a":1' },
      { name: 'array missing comma', input: '[1 2 3]' },
      { name: 'valid strict', input: '{"a":[1,2,{"b":true}]}' },
      { name: 'broken beyond repair', input: '@@@' }
    ];
    let out = '';
    cases.forEach((c) => {
      const r = parseJSONLoose(c.input);
      out += (r.ok ? 'OK  ' : 'FAIL') + ' fixes=' + (r.ok && r.fixes ? r.fixes.length : 'n/a') +
        ' value=' + (r.ok ? JSON.stringify(r.value) : '(unrepaired)') + '  << ' + c.name + '\n';
    });
    document.body.innerHTML = '<pre id="selftest">' + esc(out) + '</pre>';
  }

  // ---------- init ----------
  if (location.search.indexOf('selftest') !== -1) {
    runSelfTest();
    return;
  }
  input.value = JSON.stringify(SAMPLE, null, 2);
  renderEditor();
  runFormat();
})();
