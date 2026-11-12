// rt-settingsview: Settings form (numeric fields, base path, animations toggle).
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    function buildSettingsView() {
      const wrap = document.createElement('div');
      wrap.className = 'xft-settings';
      const mkField = (labelText, value) => {
        const row = document.createElement('label');
        row.className = 'xft-set-row';
        const t = document.createElement('span');
        t.textContent = labelText;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = String(value);
        row.append(t, inp);
        wrap.appendChild(row);
        return inp;
      };
      const inDelay = mkField('fetch delay (ms)', settings.delayMs);
      const inChunk = mkField('render chunk', settings.chunkSize);
      const inRows = mkField('panel row cap (Links)', settings.rowCap);
      const inAuto = mkField('auto fetch on load (1/0)', settings.autoFetch ? 1 : 0);
      const inAnim = mkField('force animations (1/0)', settings.forceAnimations ? 1 : 0);
      const inBase = mkField('base path (subpath installs)', settings.basePath);
      const save = mkBtn('Save', () => {
        const num = (v, def) => {
          const n = parseInt(v, 10);
          return isFinite(n) && n > 0 ? n : def;
        };
        settings.delayMs = num(inDelay.value, DEFAULT_SETTINGS.delayMs);
        settings.chunkSize = num(inChunk.value, DEFAULT_SETTINGS.chunkSize);
        settings.rowCap = num(inRows.value, DEFAULT_SETTINGS.rowCap);
        settings.autoFetch = parseInt(inAuto.value, 10) === 1 ? 1 : 0;
        settings.forceAnimations = parseInt(inAnim.value, 10) === 1 ? 1 : 0;
        settings.basePath = inBase.value.trim().replace(/\/+$/, '');
        applyAnimOverride();
        saveSettings();
        wrap.hidden = true;
        setTab(panelTab);
      });
      wrap.appendChild(save);
      wrap.hidden = true;
      return wrap;
    }

