// Setup UI — Phase F V0.1 status page + V0.8.b pairing wizard.
// Vanilla JS. No framework, no build step.
//
// Mode decision at load: GET /api/setup/state → 200 means UNPAIRED (show the
// wizard); 404 means PAIRED (wizard routes are gone — show the status view,
// polling /api/status every 2 seconds like the V0.1 page always did).
//
// Pairing-language discipline (Q2): all copy is account-level — "your account
// is paired with this bridge", never "your browser is paired".

(() => {
  const POLL_INTERVAL_MS = 2000;

  const $ = (id) => document.getElementById(id);

  // ── LAN setup token (V0.8.b "Both") ──────────────────────────────────────
  // When the wizard is opened over the LAN, the bridge requires a token on every
  // request. The install hands out a URL with ?token=… — read it once, stash it
  // in sessionStorage (so a reload in the same tab still works), and strip it
  // from the address bar so it isn't left visible or bookmarked. On
  // localhost-only installs there's no token and this is a no-op.
  const setupToken = (() => {
    const SS_KEY = 'fnSetupToken';
    try {
      const u = new URL(window.location.href);
      const fromUrl = u.searchParams.get('token');
      if (fromUrl) {
        try {
          sessionStorage.setItem(SS_KEY, fromUrl);
        } catch {
          /* sessionStorage may be unavailable — fall back to in-memory only */
        }
        u.searchParams.delete('token');
        window.history.replaceState({}, document.title, u.pathname + u.search + u.hash);
        return fromUrl;
      }
      try {
        return sessionStorage.getItem(SS_KEY) || '';
      } catch {
        return '';
      }
    } catch {
      return '';
    }
  })();

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (setupToken) h['X-Content-Bridge-Setup-Token'] = setupToken;
    return h;
  }

  // ── Theme toggle ───────────────────────────────────────────────────────────
  // The initial theme is applied pre-paint by theme-init.js (in <head>). Here we
  // wire the toggle button and keep following the OS preference until the user
  // makes an explicit choice (after which we respect their choice).
  (function setupThemeToggle() {
    const THEME_KEY = 'fnBridgeTheme';
    const btn = $('theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const cur =
          document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          /* storage unavailable — toggle still works for this session */
        }
      });
    }
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (e) => {
        let saved = null;
        try {
          saved = localStorage.getItem(THEME_KEY);
        } catch {
          /* ignore */
        }
        // Only mirror the OS while the user hasn't pinned a choice.
        if (saved !== 'light' && saved !== 'dark') {
          document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        }
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch {
      /* matchMedia unavailable — toggle still works, just no live OS sync */
    }
  })();

  // ── Wizard elements ───────────────────────────────────────────────────────
  const wiz = {
    root: $('wizard'),
    statusView: $('status-view'),
    subtitle: $('page-subtitle'),
    stepInds: [$('step-ind-1'), $('step-ind-2'), $('step-ind-3')],
    panels: [$('wizard-step-1'), $('wizard-step-2'), $('wizard-step-3')],
    // Step 1 — enter the pairing code (the one key).
    pairingCode: $('pairing-code'),
    pairError: $('pair-error'),
    pairSubmit: $('pair-submit'),
    pairBusy: $('pair-busy'),
    // Step 2 — confirm settings + folder permission checks.
    settingsLabel: $('settings-label'),
    settingsRoot: $('settings-root'),
    contentStatus: $('content-status'),
    managedPath: $('managed-path'),
    managedStatus: $('managed-status'),
    permRemediation: $('perm-remediation'),
    copyPrompt: $('copy-prompt'),
    copyPromptDone: $('copy-prompt-done'),
    remediationRunAs: $('remediation-runas'),
    rootError: $('root-error'),
    rootBusy: $('root-busy'),
    confirmSettings: $('confirm-settings'),
    settingsRecheck: $('settings-recheck'),
    // Step 3 — live setup confirmation.
    verifyDot: $('verify-dot'),
    verifyLabel: $('verify-label'),
    verifyDetail: $('verify-detail'),
    verifyError: $('verify-error'),
    verifyActions: $('verify-actions'),
    verifyRetry: $('verify-retry'),
    verifyBrowseWrap: $('verify-browse-wrap'),
    verifyBrowseLink: $('verify-browse-link'),
    verifyDoneNote: $('verify-done-note'),
    verifySvgPending: $('verify-svg-pending'),
    verifySvgOk: $('verify-svg-ok'),
    verifySvgErr: $('verify-svg-err'),
  };

  const wizardData = {
    label: '',
    rootPath: '',
    hasPrefill: false,
    managedHostPath: '',
    appUrl: '',
  };

  // Step-3 live-verification poll handles (IIFE-scoped so the verify helpers below
  // can clear/restart them independently of initWizard).
  let verifyTimer = null;
  let verifyDeadline = 0;

  // Render a ✓/✗ folder-permission result line.
  function setFolderStatus(el, ok, message) {
    if (!el) return;
    el.hidden = false;
    el.textContent = (ok ? '✓ ' : '✗ ') + (message || '');
    el.classList.remove('folder-status--ok', 'folder-status--err');
    el.classList.add(ok ? 'folder-status--ok' : 'folder-status--err');
  }

  // Latest AI setup prompt (Option A) for the copy button — set whenever a
  // permission check fails.
  let lastSetupPrompt = '';
  function showRemediation(prompt, runAs) {
    lastSetupPrompt = prompt || '';
    if (wiz.remediationRunAs && runAs) wiz.remediationRunAs.textContent = runAs;
    if (wiz.permRemediation) wiz.permRemediation.hidden = !lastSetupPrompt;
  }
  function hideRemediation() {
    if (wiz.permRemediation) wiz.permRemediation.hidden = true;
  }

  // Copy helper. navigator.clipboard needs a secure context (HTTPS/localhost);
  // the LAN wizard is plain HTTP, so fall back to a temporary textarea +
  // execCommand('copy'), which works in non-secure contexts.
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to legacy path */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  let currentStep = 1;
  function showWizardStep(n) {
    currentStep = n;
    wiz.panels.forEach((panel, i) => {
      if (panel) panel.hidden = i !== n - 1;
    });
    wiz.stepInds.forEach((ind, i) => {
      if (!ind) return;
      const stepNum = i + 1;
      ind.classList.toggle('wizard__step--active', stepNum === n);
      ind.classList.toggle('wizard__step--done', stepNum < n);
      // Completed steps are clickable to jump BACK; current/forward steps aren't
      // (you re-Verify / re-Check to move forward, so the data stays consistent).
      ind.classList.toggle('wizard__step--clickable', stepNum < n);
    });
  }

  // Step indicators: click a completed (earlier) step to go back to it.
  wiz.stepInds.forEach((ind, i) => {
    if (!ind) return;
    ind.addEventListener('click', () => {
      const target = i + 1;
      if (target < currentStep) showWizardStep(target);
    });
  });

  function showError(el, message) {
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  async function postJson(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  }

  async function initWizard(setupState) {
    if (wiz.subtitle) wiz.subtitle.textContent = 'Setup';
    wiz.root.hidden = false;
    wiz.statusView.hidden = true;
    showWizardStep(1);

    wizardData.appUrl = setupState.appUrl || '';
    // doc 118 Part A: the bridge name + content folder come from bridge.env; the wizard
    // confirms them on Step 2 rather than asking for them on Step 1.
    wizardData.label = setupState.deviceLabel || '';
    wizardData.rootPath = setupState.defaultRootSuggestion || '';
    wizardData.managedHostPath = setupState.managedHostPath || '';
    // The install may have provided a pairing code (server-side prefill). We never receive
    // the code itself, only a flag, so hint that leaving the field blank uses it.
    wizardData.hasPrefill = !!setupState.hasPrefillPairingCode;
    if (wizardData.hasPrefill && wiz.pairingCode) {
      wiz.pairingCode.placeholder =
        'Using the pairing code from your install (leave blank, or paste a different one)';
    }

    // Pre-populate Step 2's read-only confirmations (shown after the code verifies).
    if (wiz.settingsLabel) wiz.settingsLabel.textContent = wizardData.label || '—';
    if (wiz.settingsRoot) wiz.settingsRoot.textContent = wizardData.rootPath || '—';
    if (wiz.managedPath) wiz.managedPath.textContent = wizardData.managedHostPath || '—';
    if (wiz.remediationRunAs && setupState.runAs) wiz.remediationRunAs.textContent = setupState.runAs;
    // The working folder's read-write status is pre-flighted server-side on load.
    if (wiz.managedStatus && typeof setupState.managedWritable === 'boolean') {
      setFolderStatus(
        wiz.managedStatus,
        setupState.managedWritable,
        setupState.managedWritable
          ? 'Read & write OK'
          : 'Not writable yet. The bridge can’t save here; fix folder access, then re-check.'
      );
    }
    // If the working folder failed its pre-flight on load, surface the permission
    // remediation (copy-prompt + fix-perms.sh) up front.
    if (setupState.setupPrompt) {
      showRemediation(setupState.setupPrompt, setupState.runAs);
    }

    // (Removed 2026-07-29) The mounted-folder suggestion list was fetched and rendered here.
    // Selecting one reassigned `wizardData.rootPath`, which only steers the validate-root
    // check and the on-screen label — the daemon indexes CONTENT_BRIDGE_HOST_CONTENT_PATH
    // regardless — so it presented as a folder switcher that changed nothing. `GET
    // /api/setup/mounts` (setup-ui/server.ts) now has no caller; left in place rather than
    // removed, since a future "change my content folder" feature is the natural consumer and
    // it is unpaired-gated + read-only.

    // ── Step 1: verify the pairing code (claims + stashes the candidate) ──
    wiz.pairSubmit.addEventListener('click', async () => {
      showError(wiz.pairError, '');
      const pairingCode = (wiz.pairingCode.value || '').trim();
      if (!pairingCode && !wizardData.hasPrefill) {
        showError(wiz.pairError, 'Paste your pairing code first.');
        return;
      }
      wiz.pairSubmit.disabled = true;
      wiz.pairBusy.hidden = false;
      try {
        // The bridge name is env-derived server-side; there is no name field here.
        const { ok, status, data } = await postJson('/api/setup/pair', { pairingCode });
        if (!ok) {
          showError(
            wiz.pairError,
            (data && data.message) ||
              (status === 429
                ? 'Too many attempts. Wait a minute and try again.'
                : 'Pairing failed. Try again.')
          );
          return;
        }
        if (wiz.settingsLabel && data && data.deviceLabel) {
          wizardData.label = data.deviceLabel;
          wiz.settingsLabel.textContent = data.deviceLabel;
        }
        showWizardStep(2);
        // Kick off the folder pre-flight so Step 2 shows read/write status immediately.
        void checkFolders(false);
      } catch (err) {
        showError(wiz.pairError, 'Setup page unreachable. Is the bridge container running?');
      } finally {
        wiz.pairSubmit.disabled = false;
        wiz.pairBusy.hidden = true;
      }
    });

    // ── Step 2: folder permission check (shared by Confirm + Re-check) ──
    async function checkFolders(alsoComplete) {
      showError(wiz.rootError, '');
      const hostPath = (wizardData.rootPath || '').trim();
      if (!hostPath) {
        showError(
          wiz.rootError,
          'No content folder is set. Choose one from the list, or re-run the installer.'
        );
        return false;
      }
      wiz.rootBusy.hidden = false;
      wiz.confirmSettings.disabled = true;
      wiz.settingsRecheck.disabled = true;
      try {
        const { ok, data } = await postJson('/api/setup/validate-root', { hostPath });
        // Both the 200 and 422 responses carry per-folder { content, managed } results.
        const content = (data && data.content) || null;
        const managed = (data && data.managed) || null;
        if (content && wiz.contentStatus) {
          setFolderStatus(
            wiz.contentStatus,
            content.readable,
            content.readable ? 'Read OK' : content.message || 'Not readable.'
          );
        }
        if (managed) {
          if (managed.hostPath && wiz.managedPath) wiz.managedPath.textContent = managed.hostPath;
          if (wiz.managedStatus) {
            setFolderStatus(
              wiz.managedStatus,
              managed.writable,
              managed.writable ? 'Read & write OK' : managed.message || 'Not writable.'
            );
          }
        }
        if (!ok) {
          showRemediation(data && data.setupPrompt, data && data.runAs);
          showError(
            wiz.rootError,
            (content && !content.readable && content.message) ||
              (managed && !managed.writable && managed.message) ||
              'Folder check failed. See the details above.'
          );
          return false;
        }
        hideRemediation();
        if (content && content.hostPath) {
          wizardData.rootPath = content.hostPath;
          if (wiz.settingsRoot) wiz.settingsRoot.textContent = content.hostPath;
        }
        if (alsoComplete) return await completeSetup();
        return true;
      } catch (err) {
        showError(wiz.rootError, 'Setup page unreachable. Is the bridge container running?');
        return false;
      } finally {
        wiz.rootBusy.hidden = true;
        wiz.confirmSettings.disabled = false;
        wiz.settingsRecheck.disabled = false;
      }
    }

    async function completeSetup() {
      const { ok, data } = await postJson('/api/setup/complete', {});
      if (!ok) {
        showError(wiz.rootError, (data && data.message) || 'Couldn’t finish setup.');
        return false;
      }
      showWizardStep(3);
      wiz.stepInds.forEach((ind) => ind && ind.classList.add('wizard__step--done'));
      startVerify();
      return true;
    }

    wiz.confirmSettings.addEventListener('click', () => void checkFolders(true));
    wiz.settingsRecheck.addEventListener('click', () => void checkFolders(false));

    if (wiz.copyPrompt) {
      wiz.copyPrompt.addEventListener('click', async () => {
        if (!lastSetupPrompt) return;
        const ok = await copyText(lastSetupPrompt);
        if (ok && wiz.copyPromptDone) {
          wiz.copyPromptDone.hidden = false;
          setTimeout(() => {
            if (wiz.copyPromptDone) wiz.copyPromptDone.hidden = true;
          }, 2500);
        } else if (!ok) {
          showError(
            wiz.rootError,
            'Couldn’t copy automatically. The same prompt is saved in your install folder as setup-account-prompt.txt.'
          );
        }
      });
    }

    if (wiz.verifyRetry) wiz.verifyRetry.addEventListener('click', () => startVerify());
  }

  // ── Step 3: actively verify the bridge reached the account (poll /api/status) ──
  function setVerifySvg(which) {
    if (wiz.verifySvgPending) wiz.verifySvgPending.hidden = which !== 'pending';
    if (wiz.verifySvgOk) wiz.verifySvgOk.hidden = which !== 'ok';
    if (wiz.verifySvgErr) wiz.verifySvgErr.hidden = which !== 'err';
  }
  function setVerifyDot(cls) {
    if (!wiz.verifyDot) return;
    wiz.verifyDot.classList.remove('dot--ok', 'dot--warn', 'dot--err', 'dot--unknown');
    wiz.verifyDot.classList.add('dot--' + cls);
  }

  const VERIFY_TIMEOUT_MS = 30000;
  function startVerify() {
    if (verifyTimer) clearInterval(verifyTimer);
    verifyDeadline = Date.now() + VERIFY_TIMEOUT_MS;
    setVerifySvg('pending');
    setVerifyDot('warn');
    if (wiz.verifyActions) wiz.verifyActions.hidden = true;
    if (wiz.verifyBrowseWrap) wiz.verifyBrowseWrap.hidden = true;
    if (wiz.verifyDoneNote) wiz.verifyDoneNote.hidden = true;
    showError(wiz.verifyError, '');
    if (wiz.verifyLabel) wiz.verifyLabel.textContent = 'Connecting to your account...';
    if (wiz.verifyDetail) {
      wiz.verifyDetail.hidden = false;
      wiz.verifyDetail.textContent =
        'We are confirming this bridge can reach your account. This usually takes a few seconds.';
    }
    verifyTick();
    verifyTimer = setInterval(verifyTick, 1500);
  }

  async function verifyTick() {
    let data = null;
    try {
      const resp = await fetch('/api/status', { cache: 'no-store', headers: authHeaders() });
      if (!resp.ok) throw new Error('status ' + resp.status);
      data = await resp.json();
    } catch (err) {
      // The setup page itself is unreachable; keep waiting until the deadline.
      if (Date.now() > verifyDeadline) {
        verifyFailed('The setup page lost contact with the bridge. Is the container still running?');
      }
      return;
    }
    if (data.wssStatus === 'connected' && data.helloAckedAt) {
      verifySucceeded();
      return;
    }
    if (Date.now() > verifyDeadline) {
      const ev = data.lastWssEvent || {};
      const detail = ev && ev.detail ? (typeof ev.detail === 'string' ? ev.detail : JSON.stringify(ev.detail)) : '';
      const base =
        data.wssStatus === 'reconnecting'
          ? 'The bridge is still trying to reach your account (' + (data.reconnectAttempts || 0) + ' attempts).'
          : data.wssStatus === 'stopped'
            ? 'The bridge connection stopped.'
            : 'The bridge has not connected yet.';
      verifyFailed(base + (detail ? ' Last error: ' + detail : ''));
    }
  }

  function verifySucceeded() {
    if (verifyTimer) {
      clearInterval(verifyTimer);
      verifyTimer = null;
    }
    setVerifySvg('ok');
    setVerifyDot('ok');
    if (wiz.verifyLabel) wiz.verifyLabel.textContent = 'Connected. Your content is indexing.';
    if (wiz.verifyDetail) wiz.verifyDetail.hidden = true;
    showError(wiz.verifyError, '');
    if (wiz.verifyActions) wiz.verifyActions.hidden = true;
    if (wiz.verifyDoneNote) wiz.verifyDoneNote.hidden = false;
    if (wizardData.appUrl && wiz.verifyBrowseLink && wiz.verifyBrowseWrap) {
      wiz.verifyBrowseLink.href = wizardData.appUrl + '/content/bridge';
      wiz.verifyBrowseWrap.hidden = false;
    }
  }

  function verifyFailed(message) {
    if (verifyTimer) {
      clearInterval(verifyTimer);
      verifyTimer = null;
    }
    setVerifySvg('err');
    setVerifyDot('err');
    if (wiz.verifyLabel) wiz.verifyLabel.textContent = 'Not connected yet';
    if (wiz.verifyDetail) {
      wiz.verifyDetail.hidden = false;
      wiz.verifyDetail.textContent =
        'The pairing is saved. The bridge keeps retrying in the background. You can leave this page open, fix any issue below, and try again.';
    }
    showError(wiz.verifyError, message);
    if (wiz.verifyActions) wiz.verifyActions.hidden = false;
  }

  // ── Status view (paired) — the original V0.1+ poller ─────────────────────
  const els = {
    statusDot: $('status-dot'),
    statusLabel: $('status-label'),
    deviceLabel: $('kv-device-label'),
    devicePlatform: $('kv-device-platform'),
    saasUrl: $('kv-saas-url'),
    sourceRoot: $('kv-source-root'),
    appVersion: $('kv-app-version'),
    bridgeDeviceId: $('kv-bridge-device-id'),
    pairing: $('kv-pairing'),
    reconnectAttempts: $('kv-reconnect-attempts'),
    lastEvent: $('kv-last-event'),
    syncDot: $('sync-dot'),
    syncLabel: $('sync-label'),
    entriesScanned: $('kv-entries-scanned'),
    batchesPushed: $('kv-batches-pushed'),
    syncStarted: $('kv-sync-started'),
    syncFinished: $('kv-sync-finished'),
    syncLastBatch: $('kv-sync-last-batch'),
    syncError: $('kv-sync-error'),
    thumbDot: $('thumb-dot'),
    thumbLabel: $('thumb-label'),
    videosProcessed: $('kv-videos-processed'),
    imagesProcessed: $('kv-images-processed'),
    thumbsWritten: $('kv-thumbs-written'),
    thumbsPushed: $('kv-thumbs-pushed'),
    skippedDone: $('kv-skipped-done'),
    skippedUntyped: $('kv-skipped-untyped'),
    thumbFailed: $('kv-thumb-failed'),
    thumbCurrent: $('kv-thumb-current'),
    thumbStarted: $('kv-thumb-started'),
    thumbFinished: $('kv-thumb-finished'),
  };

  async function pollOnce() {
    let data = null;
    try {
      const resp = await fetch('/api/status', { cache: 'no-store', headers: authHeaders() });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      data = await resp.json();
    } catch (err) {
      setStatus('err', 'Setup UI unreachable from itself? — ' + (err && err.message ? err.message : String(err)));
      return;
    }
    renderStatus(data);
  }

  function setStatus(cls, label) {
    if (els.statusDot) {
      els.statusDot.classList.remove('dot--ok', 'dot--warn', 'dot--err', 'dot--unknown');
      els.statusDot.classList.add('dot--' + cls);
    }
    if (els.statusLabel) els.statusLabel.textContent = label;
  }

  function setSyncStatus(cls, label) {
    if (els.syncDot) {
      els.syncDot.classList.remove('dot--ok', 'dot--warn', 'dot--err', 'dot--unknown');
      els.syncDot.classList.add('dot--' + cls);
    }
    if (els.syncLabel) els.syncLabel.textContent = label;
  }

  function formatAgo(ts, nowMs) {
    if (!ts) return '—';
    const sec = Math.round((nowMs - ts) / 1000);
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.round(sec / 60) + 'm ago';
    return Math.round(sec / 3600) + 'h ago';
  }

  function setText(el, value) {
    if (el) el.textContent = value;
  }

  function renderStatus(data) {
    switch (data.wssStatus) {
      case 'connected':
        setStatus(data.helloAckedAt ? 'ok' : 'warn', data.helloAckedAt ? 'Connected · HELLO acked' : 'Connected · waiting for HELLO_ACK');
        break;
      case 'connecting':
        setStatus('warn', 'Connecting to bridge-gateway…');
        break;
      case 'reconnecting':
        setStatus('warn', 'Reconnecting (' + (data.reconnectAttempts || 0) + ' attempts)');
        break;
      case 'stopped':
        setStatus('err', 'Stopped');
        break;
      default:
        setStatus('unknown', 'Unknown · ' + data.wssStatus);
    }

    setText(els.deviceLabel, data.deviceLabel || '—');
    setText(els.devicePlatform, data.devicePlatform || '—');
    setText(els.saasUrl, data.saasUrl || '—');
    setText(els.sourceRoot, data.sourceRoot || '—');
    setText(els.appVersion, data.appVersion || '—');
    setText(els.bridgeDeviceId, data.bridgeDeviceId == null ? '—' : String(data.bridgeDeviceId));
    setText(
      els.pairing,
      data.paired
        ? 'account paired (' +
            (data.pairingSource === 'wizard'
              ? 'setup wizard'
              : data.pairingSource === 'auto'
                ? 'auto-paired'
                : 'env credential') +
            ')'
        : 'not paired'
    );
    setText(els.reconnectAttempts, String(data.reconnectAttempts || 0));

    const ev = data.lastWssEvent || {};
    if (ev.type) {
      const ago = ev.at ? Math.round((data.now - ev.at) / 1000) : null;
      const agoStr = ago == null ? '' : ' · ' + ago + 's ago';
      const detailStr = ev.detail ? ' ' + JSON.stringify(ev.detail) : '';
      setText(els.lastEvent, ev.type + agoStr + detailStr);
    } else {
      setText(els.lastEvent, '—');
    }

    // Sync status (V0.2+)
    const stats = data.syncStats || {};
    switch (data.syncStatus) {
      case 'walking':
        setSyncStatus('warn', 'Walking source root + pushing batches…');
        break;
      case 'done':
        setSyncStatus('ok', 'Initial sync complete');
        break;
      case 'error':
        setSyncStatus('err', 'Sync failed — see error row + container logs');
        break;
      case 'idle':
      default:
        setSyncStatus('unknown', 'Idle (waiting for HELLO_ACK)');
    }
    setText(els.entriesScanned, String(stats.entriesScanned ?? 0));
    setText(els.batchesPushed, String(stats.batchesPushed ?? 0));
    setText(els.syncStarted, formatAgo(stats.startedAt, data.now));
    setText(els.syncFinished, formatAgo(stats.finishedAt, data.now));
    setText(els.syncLastBatch, formatAgo(stats.lastBatchAt, data.now));
    setText(els.syncError, stats.errorMessage || '—');

    // Thumb sync (V0.3+)
    const tstats = data.thumbSyncStats || {};
    switch (data.thumbSyncStatus) {
      case 'running':
        setThumbStatus('warn', 'Processing thumbnails…');
        break;
      case 'done':
        setThumbStatus('ok', 'Thumbnail sync complete');
        break;
      case 'error':
        setThumbStatus('err', 'Thumb sync failed — see error or container logs');
        break;
      case 'idle':
      default:
        setThumbStatus('unknown', 'Idle (waits for index sync to finish)');
    }
    setText(els.videosProcessed, String(tstats.videosProcessed ?? 0));
    setText(els.imagesProcessed, String(tstats.imagesProcessed ?? 0));
    setText(els.thumbsWritten, String(tstats.thumbsWritten ?? 0));
    setText(els.thumbsPushed, String(tstats.thumbsPushed ?? 0));
    setText(els.skippedDone, String(tstats.videosSkippedAlreadyThumbed ?? 0));
    setText(els.skippedUntyped, String(tstats.videosSkippedUntyped ?? 0));
    setText(
      els.thumbFailed,
      String((tstats.videosFailed ?? 0) + (tstats.imagesFailed ?? 0))
    );
    setText(els.thumbCurrent, tstats.lastFilePath || '—');
    setText(els.thumbStarted, formatAgo(tstats.startedAt, data.now));
    setText(els.thumbFinished, formatAgo(tstats.finishedAt, data.now));
  }

  function setThumbStatus(cls, label) {
    if (els.thumbDot) {
      els.thumbDot.classList.remove('dot--ok', 'dot--warn', 'dot--err', 'dot--unknown');
      els.thumbDot.classList.add('dot--' + cls);
    }
    if (els.thumbLabel) els.thumbLabel.textContent = label;
  }

  // ── Security panel: "harden the bridge account" (paired status page) ───────
  // The browser can't change the bridge's uid live (it's fixed at container
  // creation), so this fetches tailored commands the user runs on the host, then
  // they reload to verify. See POST /api/harden-plan.
  async function initSecurityPanel() {
    const card = $('security-card');
    if (!card) return;

    async function fetchPlan(route, targetUid) {
      try {
        const resp = await fetch('/api/harden-plan', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ route: route || 'info', targetUid: targetUid || undefined }),
        });
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    }

    function renderSummary(data) {
      setText($('security-runas'), data.runAs || '—');
      const dot = $('security-dot');
      const ok = data.contentReadable && data.managedWritable;
      if (dot) {
        dot.classList.remove('dot--ok', 'dot--warn', 'dot--err', 'dot--unknown');
        dot.classList.add(ok ? 'dot--ok' : 'dot--err');
      }
      setText(
        $('security-summary'),
        'running as ' +
          (data.runAs || '—') +
          (ok ? ' · content readable, working folder writable' : ' · permission problem')
      );
    }

    function renderBlocks(blocks) {
      const wrap = $('harden-blocks');
      if (!wrap) return;
      wrap.textContent = '';
      (blocks || []).forEach((b) => {
        const box = document.createElement('div');
        box.className = 'harden-block';
        const title = document.createElement('p');
        title.className = 'harden-block__title';
        title.textContent = b.title;
        box.appendChild(title);
        if (b.body) {
          const pre = document.createElement('pre');
          pre.className = 'harden-block__cmd';
          pre.textContent = b.body;
          box.appendChild(pre);
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'button button--secondary';
          copy.textContent = 'Copy';
          copy.addEventListener('click', async () => {
            const ok = await copyText(b.body);
            copy.textContent = ok ? 'Copied ✓' : 'Copy failed';
            setTimeout(() => {
              copy.textContent = 'Copy';
            }, 2000);
          });
          box.appendChild(copy);
        }
        if (b.note) {
          const note = document.createElement('p');
          note.className = 'helper helper--tight';
          note.textContent = b.note;
          box.appendChild(note);
        }
        wrap.appendChild(box);
      });
    }

    const info = await fetchPlan('info');
    if (!info) return; // endpoint unreachable — leave the card hidden
    renderSummary(info);
    card.hidden = false;

    document.querySelectorAll('#harden-routes [data-route]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const route = btn.getAttribute('data-route');
        const data = await fetchPlan(route);
        if (!data) return;
        renderSummary(data);
        renderBlocks(data.blocks);
        const uidField = $('harden-uid-field');
        if (uidField) uidField.hidden = route !== 'guided';
        showError($('harden-uid-error'), '');
      });
    });

    const applyBtn = $('harden-uid-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        const uid = (($('harden-uid') || {}).value || '').trim();
        if (!/^\d{1,7}:\d{1,7}$/.test(uid)) {
          showError($('harden-uid-error'), 'Enter the new user’s uid:gid, e.g. 1099:100.');
          return;
        }
        showError($('harden-uid-error'), '');
        const data = await fetchPlan('guided', uid);
        if (data) renderBlocks(data.blocks);
      });
    }
  }

  function startStatusMode() {
    if (wiz.subtitle) wiz.subtitle.textContent = 'Phase F · V0.8';
    wiz.root.hidden = true;
    wiz.statusView.hidden = false;
    pollOnce();
    setInterval(pollOnce, POLL_INTERVAL_MS);
    initSecurityPanel();
  }

  // ── Mode decision ─────────────────────────────────────────────────────────
  (async () => {
    try {
      const resp = await fetch('/api/setup/state', { cache: 'no-store', headers: authHeaders() });
      if (resp.ok) {
        const setupState = await resp.json();
        await initWizard(setupState);
        return;
      }
    } catch {
      // fall through to status mode — /api/status will surface reachability
    }
    startStatusMode();
  })();
})();
