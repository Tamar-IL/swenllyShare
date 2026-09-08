// Swenlly Share — the single vanilla-JS island (architecture.md §11, §1.3 dropzone
// states, §4 copy confirmation, brief §1.4 near-real-time deliveries). No framework, no
// bundler, no inline handlers anywhere — every behaviour below is wired through
// `data-*` attributes and `addEventListener` so the CSP's `script-src 'self'` (no
// 'unsafe-inline') is satisfied by construction. Runs unconditionally on every page;
// each section guards on the element(s) it needs and no-ops otherwise.

(function () {
  'use strict';

  var liveRegion = document.getElementById('live-region');
  function announce(text) {
    if (liveRegion) liveRegion.textContent = text;
  }

  // ---------------------------------------------------------------------------------
  // Copy-to-clipboard (visual-spec.md §4.3): swap copy -> check, "הועתק" aria-label,
  // revert after 2s. `document.execCommand` fallback covers non-secure-context/older
  // browsers where `navigator.clipboard` is unavailable.
  // ---------------------------------------------------------------------------------
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('execCommand failed'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  document.querySelectorAll('[data-copy-text]').forEach(function (btn) {
    var originalLabel = btn.getAttribute('aria-label') || '';
    var iconIdle = btn.querySelector('.copy-btn__icon-idle');
    var iconDone = btn.querySelector('.copy-btn__icon-done');
    var revertTimer = null;

    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy-text');
      if (!text) return;
      copyText(text).then(
        function () {
          if (iconIdle) iconIdle.hidden = true;
          if (iconDone) iconDone.hidden = false;
          btn.setAttribute('aria-label', 'הועתק');
          announce('הועתק');
          if (revertTimer) clearTimeout(revertTimer);
          revertTimer = setTimeout(function () {
            if (iconIdle) iconIdle.hidden = false;
            if (iconDone) iconDone.hidden = true;
            btn.setAttribute('aria-label', originalLabel);
          }, 2000);
        },
        function () {
          announce('העתקה נכשלה');
        },
      );
    });
  });

  // ---------------------------------------------------------------------------------
  // Confirm dialogs (visual-spec.md §4.8): native <dialog>, so focus-trap + Escape are
  // free. Initial focus sits on the cancel button (`autofocus` in the markup).
  // ---------------------------------------------------------------------------------
  document.querySelectorAll('[data-confirm-dialog]').forEach(function (opener) {
    var dialog = document.getElementById(opener.getAttribute('data-confirm-dialog'));
    if (!dialog || typeof dialog.showModal !== 'function') return;
    opener.addEventListener('click', function () {
      dialog.showModal();
    });
    dialog.querySelectorAll('[data-dialog-cancel]').forEach(function (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        dialog.close();
      });
    });
  });

  // ---------------------------------------------------------------------------------
  // Upload: dropzone drag states, client-side size pre-flight, XHR with determinate
  // progress + cancel, then handing off to the file-detail page's own status poll
  // (UX brief §1.3).
  // ---------------------------------------------------------------------------------
  var form = document.querySelector('[data-upload-form]');
  if (form) {
    var dropzone = document.getElementById('dropzone');
    var fileInput = document.getElementById('file-input');
    var maxBytes = Number(form.getAttribute('data-max-bytes')) || Infinity;
    var csrfToken = form.getAttribute('data-csrf') || '';
    var statusLive = document.getElementById('upload-status-live');
    var xhr = null;
    var announcedSteps = {};

    function setView(name) {
      dropzone.querySelectorAll('[data-view]').forEach(function (el) {
        el.hidden = el.getAttribute('data-view') !== name;
      });
    }

    function showError(message) {
      dropzone.setAttribute('data-state', 'error');
      setView('error');
      var errText = document.getElementById('upload-error-text');
      if (errText) errText.textContent = message;
      if (statusLive) statusLive.textContent = message;
    }

    function resetToIdle() {
      dropzone.setAttribute('data-state', 'idle');
      setView('idle');
      announcedSteps = {};
    }

    function humanSize(bytes) {
      if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
      if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + 'MB';
      return Math.round(bytes / 1024) + 'KB';
    }

    function startUpload(file) {
      if (!file) return;
      if (file.size > maxBytes) {
        showError(
          'הקובץ גדול מדי (' +
            humanSize(file.size) +
            '). הגודל המרבי הוא ' +
            humanSize(maxBytes) +
            '.',
        );
        return;
      }

      dropzone.setAttribute('data-state', 'uploading');
      setView('uploading');
      var nameEl = document.getElementById('upload-filename');
      if (nameEl) nameEl.textContent = file.name;
      var progressEl = document.getElementById('upload-progress');
      var percentText = document.getElementById('upload-percent-text');
      var etaText = document.getElementById('upload-eta-text');
      if (progressEl) progressEl.value = 0;
      if (percentText) percentText.textContent = '0%';
      if (etaText) etaText.textContent = '';

      var startedAt = Date.now();
      var body = new FormData();
      body.append('file', file);

      xhr = new XMLHttpRequest();
      xhr.open('POST', form.getAttribute('action') || '/api/files');
      xhr.setRequestHeader('x-csrf-token', csrfToken);

      xhr.upload.addEventListener('progress', function (evt) {
        if (!evt.lengthComputable) return;
        var pct = Math.round((evt.loaded / evt.total) * 100);
        if (progressEl) progressEl.value = pct;
        if (percentText) percentText.textContent = pct + '%';

        var elapsedS = (Date.now() - startedAt) / 1000;
        if (etaText && evt.loaded > 0 && elapsedS > 2) {
          var rate = evt.loaded / elapsedS;
          var remainingS = Math.max(0, Math.round((evt.total - evt.loaded) / rate));
          etaText.textContent = remainingS > 4 ? '· נותרו כ-' + remainingS + ' שניות' : '';
        }

        var bucket = Math.floor(pct / 25) * 25;
        if (bucket > 0 && !announcedSteps[bucket]) {
          announcedSteps[bucket] = true;
          announce('הועלה ' + bucket + '%');
        }
      });

      xhr.addEventListener('load', function () {
        if (xhr.status === 201) {
          var data;
          try {
            data = JSON.parse(xhr.responseText);
          } catch (err) {
            showError('ההעלאה נכשלה — נסה שוב.');
            return;
          }
          announce('ההעלאה הסתיימה, מעביר לדף הקובץ');
          window.location.href = '/files/' + data.fileId;
          return;
        }
        if (xhr.status === 413) {
          var maxFromServer = maxBytes;
          try {
            maxFromServer = JSON.parse(xhr.responseText).maxBytes || maxBytes;
          } catch (err) {
            /* keep client-known maxBytes */
          }
          showError('הקובץ גדול מדי. הגודל המרבי הוא ' + humanSize(maxFromServer) + '.');
          return;
        }
        showError('ההעלאה נכשלה — נסה שוב.');
      });

      xhr.addEventListener('error', function () {
        showError('ההעלאה נכשלה — בדוק/י את החיבור ונסה שוב.');
      });
      xhr.addEventListener('abort', function () {
        resetToIdle();
      });

      xhr.send(body);
    }

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) startUpload(fileInput.files[0]);
    });

    form.addEventListener('submit', function (evt) {
      evt.preventDefault();
      if (fileInput.files && fileInput.files[0]) startUpload(fileInput.files[0]);
    });

    ['dragenter', 'dragover'].forEach(function (evtName) {
      dropzone.addEventListener(evtName, function (evt) {
        evt.preventDefault();
        if (dropzone.getAttribute('data-state') === 'idle') {
          dropzone.setAttribute('data-state', 'drag-over');
        }
      });
    });
    ['dragleave', 'dragend'].forEach(function (evtName) {
      dropzone.addEventListener(evtName, function () {
        if (dropzone.getAttribute('data-state') === 'drag-over') {
          dropzone.setAttribute('data-state', 'idle');
        }
      });
    });
    dropzone.addEventListener('drop', function (evt) {
      evt.preventDefault();
      dropzone.setAttribute('data-state', 'idle');
      var dropped = evt.dataTransfer && evt.dataTransfer.files && evt.dataTransfer.files[0];
      if (dropped) startUpload(dropped);
    });

    var cancelBtn = document.getElementById('upload-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        if (xhr) xhr.abort();
      });
    }
    var retryBtn = document.getElementById('upload-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        if (fileInput.files && fileInput.files[0]) {
          startUpload(fileInput.files[0]);
        } else {
          resetToIdle();
        }
      });
    }
  }

  // ---------------------------------------------------------------------------------
  // Publish-status poll (file-detail page, while a file is still publishing). A plain
  // reload once the status leaves "publishing" is a deliberate simplification for a
  // ~300-line vanilla island: it re-renders the now-ready distribution link/mailto card
  // server-side instead of duplicating that markup logic in JS.
  // ---------------------------------------------------------------------------------
  var statusNotice = document.querySelector('[data-poll-status]');
  if (statusNotice) {
    var statusUrl = statusNotice.getAttribute('data-status-url');
    var statusTimer = setInterval(function () {
      fetch(statusUrl, { headers: { accept: 'application/json' } })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (body) {
          if (body && body.status !== 'staged' && body.status !== 'publishing') {
            clearInterval(statusTimer);
            window.location.reload();
          }
        })
        .catch(function () {
          /* transient network error — the next tick tries again */
        });
    }, 3000);
  }

  // ---------------------------------------------------------------------------------
  // Deliveries polling (UX brief §4: "the audit log is the load-bearing trust
  // mechanism ... it must update promptly").
  // ---------------------------------------------------------------------------------
  var deliveriesSection = document.getElementById('deliveries');
  if (deliveriesSection) {
    var fileId = deliveriesSection.getAttribute('data-file-id');
    var tbody = document.getElementById('deliveries-tbody');
    var table = document.getElementById('deliveries-table');
    var emptyNote = document.getElementById('deliveries-empty');
    var since = deliveriesSection.getAttribute('data-since') || '';

    function mechanismLabel(m) {
      if (m === 'attachment') return 'קובץ מצורף';
      if (m === 'drive_share') return 'שיתוף Drive פרטי';
      return '—';
    }
    var outcomeMeta = {
      queued: ['בתהליך', 'pill-publishing'],
      sent: ['נשלח', 'pill-delivered'],
      failed: ['נכשל', 'pill-failed'],
      quarantined: ['נחסם', 'pill-quarantined'],
      rate_limited: ['הגבלת קצב', 'pill-expired'],
      expired: ['פג תוקף', 'pill-expired'],
      not_allowlisted: ['לא ברשימת ההיתר', 'pill-expired'],
    };

    function fmtDateTime(iso) {
      var d = new Date(iso);
      return (
        d.toLocaleDateString('he-IL') +
        ', ' +
        d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
      );
    }

    function prependRow(item) {
      var meta = outcomeMeta[item.outcome] || [item.outcome, 'pill-expired'];
      var tr = document.createElement('tr');
      var cells = [
        { label: 'כתובת', text: item.address, cls: 'ltr-token' },
        { label: 'אופן מסירה', text: mechanismLabel(item.mechanism), cls: 'tag' },
        { label: 'סטטוס', text: meta[0], cls: 'pill ' + meta[1] },
        { label: 'מועד', text: fmtDateTime(item.at), cls: 'ltr-token' },
      ];
      cells.forEach(function (col) {
        var td = document.createElement('td');
        td.setAttribute('data-label', col.label);
        var span = document.createElement('span');
        span.className = col.cls;
        span.textContent = col.text;
        td.appendChild(span);
        tr.appendChild(td);
      });
      tbody.insertBefore(tr, tbody.firstChild);
    }

    function poll() {
      var url =
        '/api/files/' +
        fileId +
        '/deliveries' +
        (since ? '?since=' + encodeURIComponent(since) : '');
      fetch(url, { headers: { accept: 'application/json' } })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (data) {
          if (!data || !data.items || data.items.length === 0) return;
          data.items
            .slice()
            .reverse()
            .forEach(function (item) {
              prependRow(item);
            });
          since = data.items[0].at;
          if (emptyNote) emptyNote.hidden = true;
          if (table) table.hidden = false;
          announce('התקבלה בקשה חדשה לקובץ');
        })
        .catch(function () {
          /* transient network error — the next tick tries again */
        });
    }

    setInterval(poll, 5000);
  }
})();
