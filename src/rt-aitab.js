// rt-aitab: AI tab runtime: chat state (aiSeq rebuild guard), aiRequest (GM stream + fallback), send/dispatch (SEARCH protocol), test connection, markdown DOM renderer, renderAiTab.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- AI chat tab (v0.10.0) ----------
    // Chat about the cached thread posts. Providers speak OpenAI
    // chat-completions (Ollama ships that layer at <origin>/v1); transcript
    // is rebuilt from the post cache on every send, so context grows as the
    // crawl fills pages. History is session-only; config lives in settings.
    let aiViewEl = null;
    let aiLogEl = null;
    let aiCtxEl = null;
    let aiInputEl = null;
    let aiSeq = 0; // bump = rebuild the AI view (fetch ticks must not wipe drafts)
    const aiChat = { msgs: [], pending: false, abort: null, models: [], modelsLoading: false, cfgOpen: false, streamText: '', ctxLens: {} };

    function aiCfgReady() {
      return !!settings.aiModel && !(settings.aiProvider === 'openai' && !settings.aiKey);
    }
    function aiCtxText() {
      const recs = orderedRecords();
      let chars = 0;
      for (const r of recs) chars += String(r.bodyHtml || '').length;
      const m = settings.aiModel || 'no model';
      const numCtx = aiNumCtx(settings.aiCtxTokens, aiChat.ctxLens[settings.aiModel]);
      const sent = Math.min(chars, aiTranscriptBudget(numCtx));
      const st = aiContextStats(sent, numCtx);
      const usage = st ? ' · ~' + st.pct + '% of ' + st.ctx + ' ctx' : '';
      return recs.length
        ? 'context: ' + recs.length + ' posts · sending ~' + (Math.round(sent / 100) / 10) + 'k of ~' + (Math.round(chars / 100) / 10) + 'k chars' + usage + ' · ' + m
        : 'no posts cached yet · ' + m;
    }
    // one request shape for chat + model list; GM XHR (CORS-free — required
    // for api.openai.com and cross-origin Ollama) with a fetch fallback.
    // 120s timeout: local models are slow before the first token.
    // onChunk (optional) streams the body incrementally: TM's onprogress
    // reports the FULL responseText so far — normalized to deltas here.
    function aiRequest(method, url, bodyObj, cb, onChunk) {
      let fin = cb;
      const finish = (v) => { if (fin) { const f = fin; fin = null; f(v); } };
      const headers = { 'Content-Type': 'application/json' };
      if (settings.aiKey) headers.Authorization = 'Bearer ' + settings.aiKey;
      const onJson = (status, text) => {
        let v = null;
        try { v = JSON.parse(text); } catch (e) { /* non-JSON body */ }
        if (status >= 200 && status < 300) finish({ ok: true, json: v, text: String(text || '') });
        else finish({ error: (v && v.error && typeof v.error.message === 'string') ? v.error.message : 'HTTP ' + status });
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        let seen = 0;
        let streamLive = false; // reader path produced chunks -> the single MV3 onprogress event is redundant
        let streamed = '';
        let reader = null;
        try {
          const rq = GM_xmlhttpRequest({
            method: method, url: url, headers: headers, timeout: 120000,
            data: bodyObj ? JSON.stringify(bodyObj) : undefined,
            responseType: onChunk ? 'stream' : undefined,
            // Tampermonkey MV3 fires ONLY ONE progress event per request
            // (changelog 5.3.6222): with responseType 'stream' the stream
            // object arrives at onloadstart and must be read via a reader.
            onloadstart: (r) => {
              const st = r && r.response;
              if (!onChunk || !st || typeof st.getReader !== 'function') return;
              reader = st.getReader();
              const dec = new TextDecoder();
              (async () => {
                try {
                  for (;;) {
                    const st2 = await reader.read();
                    if (st2.done) break;
                    const piece = dec.decode(st2.value, { stream: true });
                    if (piece) { streamed += piece; streamLive = true; onChunk(piece); }
                  }
                } catch (e) { /* stream teardown; onload/onerror settles the request */ }
              })();
            },
            onprogress: (r) => {
              if (!onChunk || streamLive || !r || typeof r.responseText !== 'string') return;
              if (r.responseText.length > seen) { onChunk(r.responseText.slice(seen)); seen = r.responseText.length; }
            },
            onload: (r) => {
              const text = streamLive ? streamed : (r ? String(r.responseText || '') : '');
              onJson(r ? r.status | 0 : 0, text);
            },
            onerror: () => finish({ error: 'network' }),
            ontimeout: () => finish({ error: 'timeout' })
          });
          return { abort: () => { try { if (reader && reader.cancel) reader.cancel(); } catch (e) {} try { if (rq && rq.abort) rq.abort(); } catch (e) {} finish({ error: 'stopped' }); } };
        } catch (e) { /* fall through to fetch */ }
      }
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      if (ctl) setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 120000);
      fetch(url, {
        method: method, headers: headers, credentials: 'omit',
        signal: ctl ? ctl.signal : undefined,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined
      })
        .then(async (r) => {
          if (!onChunk || !r.body || !r.body.getReader) { onJson(r.status, await r.text()); return; }
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let full = '';
          for (;;) {
            const st = await reader.read();
            if (st.done) break;
            const piece = dec.decode(st.value, { stream: true });
            full += piece;
            onChunk(piece);
          }
          onJson(r.status, full);
        })
        .catch(() => finish({ error: 'network' }));
      return { abort: () => { try { if (ctl) ctl.abort(); } catch (e) {} } };
    }
    function aiSend(q) {
      const question = String(q || '').trim();
      if (!question || aiChat.pending) return;
      if (!aiCfgReady()) { aiChat.cfgOpen = true; aiSeq++; renderAiTab(true); return; }
      aiChat.msgs.push({ role: 'user', content: question });
      aiChat.pending = true;
      aiChat.streamText = '';
      aiSeq++;
      renderAiTab(true);
      dispatchAi(question, null);
    }
    // follow = { kw, posts } for the SEARCH re-ask; null for a fresh question.
    // The follow-up fences the SEARCH hits and re-asks the original question —
    // one user action, up to two requests.
    function dispatchAi(question, follow) {
      const ep = aiEndpoint(settings);
      const native = settings.aiProvider === 'ollama';
      const pmode = native ? 'ollama' : 'openai';
      const posts = follow ? follow.posts : orderedRecords().map((r) => ({ author: r.author, pageN: r.pageN, reactionCount: r.reactionCount, text: htmlToText(r.bodyHtml) }));
      const numCtx = aiNumCtx(settings.aiCtxTokens, aiChat.ctxLens[settings.aiModel]);
      const budget = aiTranscriptBudget(numCtx);
      const transcript = follow
        ? buildAiTranscript(posts, { budget: budget, query: follow.kw })
        : buildAiTranscript(posts, { budget: budget, query: question });
      const finalQ = follow
        ? 'Thread search results for "' + follow.kw + '" are fenced above. Using them, answer the user\'s question: ' + question
        : question;
      const hist = follow
        ? aiChat.msgs.filter((m) => m.role === 'user' || m.role === 'assistant')
        : aiChat.msgs.slice(0, -1).filter((m) => m.role === 'user' || m.role === 'assistant');
      const msgs = aiMessages(transcript, finalQ, hist, settings.aiLang);
      // Ollama native /api/chat carries think:false (instant answers — the
      // OpenAI-compat /v1 endpoint ignores the field and thinking models burn
      // the whole budget on hidden reasoning first). num_ctx opens the usable
      // window (auto = model max capped at 16k; the Context setting overrides)
      // — without it Ollama silently runs 4096 and truncates the transcript
      // from the front.
      const body = native
        ? { model: settings.aiModel, messages: msgs, stream: true, think: false, options: { num_ctx: numCtx } }
        : { model: settings.aiModel, messages: msgs, stream: true };
      const sse = aiSseParser(pmode);
      let acc = '';
      let lastPaint = 0;
      const onChunk = (piece) => {
        for (const d of sse.push(piece)) acc += d;
        if (!acc) return;
        aiChat.streamText = acc;
        const now = Date.now();
        if (now - lastPaint >= 150) { lastPaint = now; aiSeq++; renderAiTab(true); } // throttled live bubble
      };
      aiChat.abort = aiRequest('POST', native ? aiNativeChatUrl(ep.base) : ep.chat, body, (res) => {
        aiChat.pending = false;
        aiChat.abort = null;
        let fin = null;
        if (res && res.ok) {
          if (!acc && res.text) { // no onprogress events: parse the full stream body in one shot
            const whole = aiSseParser(pmode);
            for (const d of whole.push(res.text)) acc += d;
          }
          if (acc) fin = { text: acc };
          else {
            const p = parseAiReply(res.json !== null && res.json !== undefined ? res.json : res.text);
            if (p.text) fin = p; // server ignored stream:true and answered plain JSON
          }
        }
        // SEARCH protocol: the model says the answer is in the omitted posts —
        // search the FULL cached thread and re-ask. One follow-up max (never
        // when this already IS the follow-up). Keywords come from model output
        // but only feed the local lexical scorer — nothing is executed.
        const text = fin ? fin.text : '';
        const sm = (!follow && text && text.trim().length <= 160) ? /^SEARCH:[ \t]*(.+)$/m.exec(text.trim()) : null;
        if (sm) {
          const kw = sm[1].trim().slice(0, 200);
          const found = aiSearchPosts(orderedRecords().map((r) => ({ author: r.author, pageN: r.pageN, reactionCount: r.reactionCount, text: htmlToText(r.bodyHtml) })), kw, 60);
          aiChat.msgs.push({ role: 'assistant', content: text });
          aiChat.msgs.push({ role: 'note', content: found.length
            ? '⟳ searching the full thread for "' + kw + '" — ' + found.length + ' posts found, asking again…'
            : '⟳ searched the full thread for "' + kw + '" — no cached posts match; the answer may be on uncrawled pages' });
          aiChat.streamText = '';
          aiSeq++;
          if (found.length) {
            aiChat.pending = true; // one user action, two requests — the pend bubble stays
            renderAiTab(true);
            dispatchAi(question, { kw: kw, posts: found });
            return;
          }
          renderAiTab(true);
          return;
        }
        if (fin) aiChat.msgs.push({ role: 'assistant', content: fin.text });
        else if (acc && res && res.error === 'stopped') aiChat.msgs.push({ role: 'assistant', content: acc }); // keep the partial on Stop
        else aiChat.msgs.push({ role: 'error', content: 'AI: ' + ((res && res.error) || 'failed') });
        aiChat.streamText = '';
        aiSeq++;
        renderAiTab(true);
      }, onChunk);
    }
    function aiTestConn(base) {
      if (aiChat.modelsLoading) return;
      aiChat.modelsLoading = true;
      aiChat.testMsg = '…connecting';
      aiSeq++;
      renderAiTab(true);
      aiRequest('GET', aiOllamaOrigin(base) + '/api/tags', null, (res) => {
        aiChat.modelsLoading = false;
        if (res && res.ok) {
          aiChat.models = parseAiModels(res.json !== null && res.json !== undefined ? res.json : res.text);
          aiChat.ctxLens = {};
          const arr = res.json && Array.isArray(res.json.models) ? res.json.models : [];
          for (const mo of arr) if (mo && mo.name && mo.details && mo.details.context_length) aiChat.ctxLens[mo.name] = mo.details.context_length;
          if (aiChat.models.length && aiChat.models.indexOf(settings.aiModel) < 0) settings.aiModel = aiChat.models[0];
          aiChat.testMsg = '✓ connected — ' + aiChat.models.length + ' models';
          saveSettings();
        } else {
          aiChat.testMsg = '✗ ' + ((res && res.error) || 'failed');
        }
        aiSeq++;
        renderAiTab(true);
      });
    }
    // assistant markdown -> DOM: tokens built by the pure mdParse; elements
    // and text nodes only (no innerHTML anywhere on this path)
    function mdInlineInto(el, segs) {
      for (const s of segs) {
        if (s.c === 'code') {
          const c = document.createElement('code');
          c.className = 'xft-ai-icode';
          c.textContent = s.s;
          el.appendChild(c);
        } else if (s.c === 'strong') {
          const b = document.createElement('strong');
          b.textContent = s.s;
          el.appendChild(b);
        } else if (s.c === 'em') {
          const e = document.createElement('em');
          e.textContent = s.s;
          el.appendChild(e);
        } else if (s.c === 'link') {
          const a = document.createElement('a');
          a.href = s.href; // http(s) only, enforced at token level
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = s.s;
          el.appendChild(a);
        } else {
          const parts = String(s.s).split('\n'); // soft newlines -> <br>
          for (let k = 0; k < parts.length; k++) {
            if (k) el.appendChild(document.createElement('br'));
            if (parts[k]) el.appendChild(document.createTextNode(parts[k]));
          }
        }
      }
    }
    function mdRenderInto(el, blocks) {
      for (const b of blocks) {
        if (b.t === 'hr') { el.appendChild(document.createElement('hr')); continue; }
        if (b.t === 'code') {
          const pre = document.createElement('pre');
          pre.className = 'xft-ai-code';
          const code = document.createElement('code');
          code.textContent = b.text;
          pre.appendChild(code);
          el.appendChild(pre);
          continue;
        }
        let wrap;
        if (b.t === 'h') wrap = document.createElement('h' + Math.min(4, Math.max(2, b.level)));
        else if (b.t === 'quote') { wrap = document.createElement('blockquote'); }
        else if (b.t === 'ul' || b.t === 'ol') {
          wrap = document.createElement(b.t);
          for (const item of b.items) {
            const li = document.createElement('li');
            mdInlineInto(li, item);
            wrap.appendChild(li);
          }
          el.appendChild(wrap);
          continue;
        } else wrap = document.createElement('p');
        mdInlineInto(wrap, b.segs);
        el.appendChild(wrap);
      }
    }

    function renderAiTab(force) {
      if (!panelBodyEl) return;
      if (panelCountEl) panelCountEl.textContent = 'AI';
      // seqKey drives view rebuilds — provider/base/model/cfg affect the UI,
      // the KEY does not (Save bumps aiSeq) and must never appear in the DOM
      const seqKey = aiSeq + ':' + settings.aiProvider + ':' + settings.aiModel + ':' + settings.aiBase + ':' + (aiChat.testMsg || '') + ':' + (aiChat.cfgOpen ? 'c' : '-');
      if (!force && aiViewEl && aiViewEl.isConnected && aiViewEl.dataset.seq === seqKey) {
        if (aiCtxEl) aiCtxEl.textContent = aiCtxText(); // post count grows while crawling
        return;
      }
      // stash the live media window BEFORE the swap (same contract as the
      // media/links body swap — replaceChildren would GC the rows + imgs)
      if (vAttached.length) {
        for (const a of vAttached) poolPut(a.sig, a.el);
        vAttached = [];
        vRange = { first: -1, last: -1, version: -1 };
      }
      vRowsEl = null;
      const draft = aiInputEl && aiInputEl.isConnected ? aiInputEl.value : null; // live-rebuild safe
      const wrap = document.createElement('div');
      wrap.className = 'xft-ai';
      wrap.dataset.seq = seqKey;

      // config strip (collapsible) — Ollama-only phase: base URL + Test + model.
      // Everything commits the moment it changes: a rebuild (Test round-trip)
      // must never revert a control to a stale stored value.
      const cfg = document.createElement('div');
      cfg.className = 'xft-ai-cfg';
      cfg.hidden = !aiChat.cfgOpen;
      const OLLAMA_BASE = aiEndpoint({ provider: 'ollama' }).base;
      const mkRow = (labelText) => {
        const row = document.createElement('label');
        row.className = 'xft-set-row';
        const t = document.createElement('span');
        t.textContent = labelText;
        row.appendChild(t);
        cfg.appendChild(row);
        return row;
      };
      const baseRow = mkRow('Base URL');
      const baseInp = document.createElement('input');
      baseInp.type = 'text';
      baseInp.value = settings.aiBase || OLLAMA_BASE; // autofilled, editable
      baseInp.placeholder = OLLAMA_BASE;
      const testBtn = mkBtn(aiChat.modelsLoading ? '…' : 'Test', () => {
        const b = baseInp.value.trim() || OLLAMA_BASE;
        baseInp.value = b;
        settings.aiBase = b === OLLAMA_BASE ? '' : b; // '' = preset default
        saveSettings();
        aiTestConn(b); // success also loads + commits the model list
      }, 'xft-btn');
      baseRow.append(baseInp, testBtn);
      const modelRow = mkRow('Model');
      const modelSel = document.createElement('select');
      modelSel.className = 'xft-gsel';
      modelSel.style.flex = '1';
      const list = aiChat.models.length ? aiChat.models : (settings.aiModel ? [settings.aiModel] : []);
      for (const id of list) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = id;
        modelSel.appendChild(o);
      }
      if (!list.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '(press Test)';
        modelSel.appendChild(o);
      }
      modelSel.value = settings.aiModel || list[0] || '';
      modelSel.addEventListener('change', () => {
        settings.aiModel = modelSel.value || '';
        saveSettings();
        // no rebuild — the base input may hold uncommitted edits
        if (aiCtxEl) aiCtxEl.textContent = aiCtxText();
      });
      modelRow.appendChild(modelSel);
      const langRow = mkRow('Prompt language');
      const langSel = document.createElement('select');
      langSel.className = 'xft-gsel';
      langSel.style.flex = '1';
      for (const l of [['en', 'English'], ['vi', 'Tiếng Việt']]) {
        const o = document.createElement('option');
        o.value = l[0];
        o.textContent = l[1];
        langSel.appendChild(o);
      }
      langSel.value = settings.aiLang === 'vi' ? 'vi' : 'en';
      langSel.addEventListener('change', () => {
        settings.aiLang = langSel.value;
        saveSettings();
        aiSeq++;
        renderAiTab(true); // relabels the quick prompts (input draft is stashed+restored)
      });
      langRow.appendChild(langSel);
      const ctxRowCfg = mkRow('Context');
      const ctxSel = document.createElement('select');
      ctxSel.className = 'xft-gsel';
      ctxSel.style.flex = '1';
      for (const c of [[0, 'Auto'], [8192, '8k'], [16384, '16k'], [32768, '32k'], [65536, '64k'], [131072, '128k']]) {
        const o = document.createElement('option');
        o.value = String(c[0]);
        o.textContent = c[1];
        ctxSel.appendChild(o);
      }
      ctxSel.value = String(settings.aiCtxTokens > 0 ? settings.aiCtxTokens | 0 : 0);
      ctxSel.addEventListener('change', () => {
        settings.aiCtxTokens = parseInt(ctxSel.value, 10) || 0;
        saveSettings();
        if (aiCtxEl) aiCtxEl.textContent = aiCtxText(); // bigger window = bigger slice, no rebuild needed
      });
      ctxRowCfg.appendChild(ctxSel);
      if (aiChat.testMsg) {
        const st = document.createElement('div');
        st.className = 'xft-ai-testmsg' + (/^✗/.test(aiChat.testMsg) ? ' xft-ai-testbad' : '');
        st.textContent = aiChat.testMsg;
        cfg.appendChild(st);
      }
      const hint = document.createElement('div');
      hint.className = 'xft-ai-hint';
      hint.textContent = 'Ollama only for now — the model list and chat run against the Base URL above. Post texts are sent to that endpoint. Chat uses Ollama\'s native API with thinking off (think:false) — gemma4/qwen3.5 answer instantly.';
      cfg.appendChild(hint);

      // context status + config toggle
      const ctxRow = document.createElement('div');
      ctxRow.className = 'xft-ai-ctxrow';
      aiCtxEl = document.createElement('span');
      aiCtxEl.className = 'xft-ai-ctx';
      aiCtxEl.textContent = aiCtxText();
      ctxRow.append(
        aiCtxEl,
        mkBtn('＋ New chat', () => {
          if (aiChat.pending) return; // Stop first — never drop a live stream
          aiChat.msgs = [];
          aiChat.streamText = '';
          aiSeq++;
          renderAiTab(true);
        }, 'xft-btn xft-ai-clear'),
        mkBtn('⚙ AI settings', () => { aiChat.cfgOpen = !aiChat.cfgOpen; aiSeq++; renderAiTab(true); }, 'xft-btn')
      );
      const clearBtnEl = ctxRow.querySelector('.xft-ai-clear');
      if (clearBtnEl) {
        clearBtnEl.title = 'New chat';
        clearBtnEl.disabled = aiChat.pending;
      }

      // message log (session history; roles user/assistant/error)
      aiLogEl = document.createElement('div');
      aiLogEl.className = 'xft-ai-log';
      if (!aiChat.msgs.length && !aiChat.pending) {
        const e0 = document.createElement('div');
        e0.className = 'xft-ai-empty';
        e0.textContent = aiCfgReady()
          ? 'Ask anything about this thread — it summarizes, finds posts, explains comments.'
          : 'Set the Base URL and press Test (⚙ AI settings) to load your Ollama models.';
        aiLogEl.appendChild(e0);
      }
      for (const m of aiChat.msgs) {
        const d = document.createElement('div');
        d.className = 'xft-ai-m ' + (m.role === 'user' ? 'xft-ai-user' : m.role === 'assistant' ? 'xft-ai-asst' : m.role === 'note' ? 'xft-ai-note' : 'xft-ai-err');
        if (m.role === 'assistant') mdRenderInto(d, mdParse(m.content));
        else d.textContent = m.content; // user input + notes + errors stay literal
        aiLogEl.appendChild(d);
      }
      if (aiChat.pending) {
        const d = document.createElement('div');
        d.className = 'xft-ai-m xft-ai-asst xft-ai-pend';
        if (aiChat.streamText) { // live-streamed reply, re-marked-down on each throttled paint
          mdRenderInto(d, mdParse(aiChat.streamText));
          d.appendChild(document.createTextNode('▍'));
        } else {
          d.textContent = '…';
        }
        aiLogEl.appendChild(d);
      }

      // quick prompts + input bar
      const quick = document.createElement('div');
      quick.className = 'xft-ai-quick';
      const vi = settings.aiLang === 'vi';
      quick.append(
        mkBtn(vi ? 'Tóm tắt' : 'Summarize', () => aiSend(vi
          ? 'Tóm tắt chủ đề này đến giờ: chủ đề chính, các bài đáng chú ý, cảm nhận chung.'
          : 'Summarize this thread so far: main topics, notable posts, overall sentiment.'), 'xft-btn'),
        mkBtn(vi ? 'Bài nổi bật' : 'Top posts', () => aiSend(vi
          ? 'Những bài viết nào quan trọng hoặc thú vị nhất, vì sao? Trích dẫn theo #số và tên tác giả.'
          : 'Which posts are most important or interesting, and why? Reference them by #number and author.'), 'xft-btn')
      );
      const bar = document.createElement('div');
      bar.className = 'xft-ai-bar';
      aiInputEl = document.createElement('textarea');
      aiInputEl.className = 'xft-ai-input';
      aiInputEl.rows = 2;
      aiInputEl.placeholder = 'Ask about this thread… (Enter = send, Shift+Enter = newline)';
      const act = () => {
        if (aiChat.pending) { if (aiChat.abort) aiChat.abort(); return; }
        const v = aiInputEl.value;
        aiInputEl.value = '';
        aiSend(v);
      };
      aiInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); act(); }
      });
      const sendBtn = mkBtn(aiChat.pending ? '■' : '➤', act, 'xft-btn xft-ai-send');
      sendBtn.title = aiChat.pending ? 'Stop' : 'Send';
      bar.append(aiInputEl, sendBtn);

      wrap.append(cfg, ctxRow, aiLogEl, quick, bar);
      panelBodyEl.replaceChildren(wrap);
      aiViewEl = wrap;
      if (draft !== null && aiInputEl) aiInputEl.value = draft;
      aiLogEl.scrollTop = aiLogEl.scrollHeight;
      panelBodyEl.scrollTop = scrollMemory[viewKey()] || 0;
    }

