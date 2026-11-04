// The source image, its motion prompt, and every resulting video stay together. API keys and provider
// polling belong on the server; this controller only follows the world's persisted generation records.
import { api, type SlideDoc, type VideoGeneration } from './api.ts';
import { h } from './dom.ts';
import { characterCount, MAX_SLIDE_TITLE_CHARS, MAX_VIDEO_INPUT_BYTES, MAX_VIDEO_PROMPT_CHARS, videoInputBytes } from '../../server/src/video-limits.ts';
import './videos.css';
import './capture-note.css';

export interface VideoEditor {
  el: HTMLElement;
  setTitle(title: string): void;
  selectVideo(id: string): void;
  dispose(): void;
}
export interface VideoEditorOptions {
  editable?: boolean;
  previewUrl?: string;
  showTitle?: boolean;
}
export interface VideoStudio {
  mountEditor(slide: SlideDoc, container: HTMLElement, options?: VideoEditorOptions): VideoEditor;
  open(slide: SlideDoc): void;
  refresh(): Promise<void>;
  setEditable(editable: boolean): void;
  dispose(): void;
}

const pending = (job: VideoGeneration) => !['succeeded', 'failed', 'submission_unknown'].includes(job.status);
const ready = (job: VideoGeneration) => job.status === 'succeeded' && !!job.videoUrl;
const statusText = (job: VideoGeneration) => ({
  queued: 'Waiting to start', uploading: 'Preparing the first frame', generating: 'Generating video',
  saving: 'Saving video', succeeded: 'Video ready', failed: 'Video failed',
  submission_unknown: 'Submission needs checking',
})[job.status] ?? 'Generating video';
const videoIcon = () => h('span.video-glyph', { 'aria-hidden': 'true' }, '▶');

export function createVideoStudio(mount: HTMLElement, worldId: string, options: { editable?: boolean } = {}): VideoStudio {
  let editable = options.editable ?? false;
  let disposed = false;
  let jobs: VideoGeneration[] = [];
  let pollTimer = 0;
  let fetching: Promise<void> | null = null;
  let connectionError = '';
  let dismissed = false;
  let loaded = false;
  let submissionRevision = 0;
  let dialog: HTMLDialogElement | null = null;
  let dialogEditor: VideoEditor | null = null;
  let dialogRequest = 0;
  const subscribers = new Set<() => void>();
  const archivedSources = new Set<string>();
  const thumbnails = new Map<string, Promise<string>>();
  const cancelThumbnails = new Set<() => void>();
  const editors = new Set<VideoEditor>();
  const dock = h('aside.video-dock', { hidden: true, 'aria-label': 'Video generations' });
  const bubble = h('div.video-bubble', { hidden: true });
  // A separate live region is updated only when a job changes, rather than announcing every poll.
  const live = h('div.video-live', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  mount.append(dock, bubble, live);
  let lastAnnouncement = '';

  const listenLocally = (el: HTMLElement) => {
    // Viewer navigation is global. Keep all interactions with an editor or player inside the UI.
    for (const event of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click', 'wheel']) {
      el.addEventListener(event, (e) => e.stopPropagation());
    }
  };
  listenLocally(dock);
  listenLocally(bubble);

  function midpointThumbnail(job: VideoGeneration): Promise<string> {
    if (job.thumbnailUrl) return Promise.resolve(job.thumbnailUrl);
    if (!job.videoUrl || !ready(job)) return Promise.resolve('');
    const existing = thumbnails.get(job.id);
    if (existing) return existing;
    const task = new Promise<string>((resolve) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      let finished = false;
      let seeking = false;
      let frameWait = 0;
      let frameCallback = 0;
      const finish = (url = '') => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(frameWait);
        if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameCallback);
        cancelThumbnails.delete(cancel);
        video.pause();
        video.removeAttribute('src');
        video.load();
        resolve(url);
      };
      const cancel = () => finish();
      const timer = window.setTimeout(cancel, 18000);
      cancelThumbnails.add(cancel);
      const drawFrame = () => {
        if (finished) return;
        try {
          // A server without byte-range support can silently reset a failed seek to zero.
          // Keep the play placeholder in that case instead of showing the shared first frame.
          if (Math.abs(video.currentTime - video.duration / 2) > 0.45) { finish(); return; }
          if (!video.videoWidth || !video.videoHeight) { finish(); return; }
          const canvas = document.createElement('canvas');
          canvas.width = 240;
          canvas.height = Math.max(1, Math.round(240 * video.videoHeight / video.videoWidth));
          const context = canvas.getContext('2d');
          if (!context) { finish(); return; }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.84));
        } catch { finish(); }
      };
      // Decode the initial frame before seeking. Some browsers report a seek from loadedmetadata before
      // their first decoded frame arrives, then still expose that first frame to drawImage on seeked.
      video.addEventListener('loadeddata', () => {
        if (seeking || finished) return;
        if (!Number.isFinite(video.duration) || video.duration <= 0) { finish(); return; }
        seeking = true;
        // Never use the first frame for a completed video's tile: siblings have the same first frame.
        video.currentTime = video.duration / 2;
      }, { once: true });
      video.addEventListener('seeked', () => {
        if (finished) return;
        if (typeof video.requestVideoFrameCallback === 'function') {
          const waitForMidpoint = (_time: number, frame: VideoFrameCallbackMetadata) => {
            frameCallback = 0;
            if (finished) return;
            if (Math.abs(frame.mediaTime - video.duration / 2) <= 0.3) drawFrame();
            else frameCallback = video.requestVideoFrameCallback(waitForMidpoint);
          };
          frameCallback = video.requestVideoFrameCallback(waitForMidpoint);
          // A paused detached video is not composited on every browser. Muted playback asks the decoder
          // for the sought frame; stop immediately once its timestamp reaches the midpoint.
          void video.play().catch(() => { /* A timed fallback handles browsers that deny decoder playback. */ });
        }
        frameWait = window.setTimeout(drawFrame, 250);
      }, { once: true });
      video.addEventListener('error', cancel, { once: true });
      video.src = job.videoUrl!;
      video.load();
    });
    thumbnails.set(job.id, task);
    return task;
  }

  function addThumbnail(host: HTMLElement, job: VideoGeneration) {
    host.append(videoIcon());
    const showImage = (url: string) => {
      if (disposed || !host.isConnected || !url) return;
      const image = h('img', { src: url, alt: '', loading: 'lazy', draggable: false });
      image.addEventListener('load', () => { if (!disposed) host.classList.add('has-thumbnail'); }, { once: true });
      // A stale server image should still leave an identifiable play tile, never the shared first frame.
      image.addEventListener('error', () => image.remove(), { once: true });
      host.prepend(image);
    };
    // Cached/server thumbnails may be attached before the button is mounted.
    void midpointThumbnail(job).then((url) => { if (host.isConnected) showImage(url); else requestAnimationFrame(() => showImage(url)); });
  }

  function closeDialog() {
    dialogRequest++;
    dialogEditor?.dispose();
    dialogEditor = null;
    if (dialog) {
      dialog.close();
      dialog.remove();
      dialog = null;
    }
  }

  function makeDialog(title: string) {
    closeDialog();
    const heading = h('h2.video-dialog-title', title);
    const close = h('button.video-dialog-close', { type: 'button', 'aria-label': 'Close video editor' }, '×');
    const body = h('div.video-dialog-body');
    const el = h('dialog.video-dialog', h('header.video-dialog-head', heading, close), body) as HTMLDialogElement;
    listenLocally(el);
    close.addEventListener('click', closeDialog);
    el.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
    el.addEventListener('click', (event) => { if (event.target === el) closeDialog(); });
    mount.append(el);
    dialog = el;
    el.showModal();
    return body;
  }

  function open(slide: SlideDoc, selected?: string) {
    if (disposed) return;
    const body = makeDialog('Bring this image to life');
    dialogEditor = mountEditor(slide, body);
    if (selected) dialogEditor.selectVideo(selected);
    // A restored/persisted job may have completed since the last poll.
    void refresh();
  }

  async function openJob(job: VideoGeneration) {
    if (disposed) return;
    const body = makeDialog(job.title || 'Your video');
    body.append(h('p.video-note', 'Opening capture…'));
    const request = ++dialogRequest;
    let slide: SlideDoc | undefined;
    try {
      const slides = await api.worldSlides(worldId);
      if (disposed || request !== dialogRequest) return;
      for (const item of slides) archivedSources.delete(item.id);
      slide = slides.find((item) => item.id === job.slideId);
    } catch { /* A saved video remains playable when the source can no longer be fetched. */ }
    if (disposed || request !== dialogRequest || !dialog) return;
    if (slide) {
      body.replaceChildren();
      dialogEditor = mountEditor(slide, body);
      dialogEditor.selectVideo(job.id);
      return;
    }
    // Deleted captures retain the immutable image used for their generation, and their completed clips.
    body.replaceChildren();
    if (job.sourceImageUrl) {
      archivedSources.add(job.slideId);
      const snapshot: SlideDoc = {
        id: job.slideId, world: worldId, worldTitle: '', kind: 'view', title: job.title,
        caption: job.prompt, takenAt: job.createdAt, createdAt: job.createdAt,
        image: { url: job.sourceImageUrl, thumb: job.sourceImageUrl, width: 1, height: 1 },
        entry: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: 50, aspect: 1 },
      };
      dialogEditor = mountEditor(snapshot, body, { editable: false });
      dialogEditor.selectVideo(job.id);
      return;
    }
    if (job.videoUrl) body.append(h('video.video-standalone', { src: job.videoUrl, controls: true, playsInline: true, poster: job.thumbnailUrl }));
    body.append(h('p.video-note', job.prompt), h('p.video-note', job.error || statusText(job)));
  }

  function renderDock() {
    if (disposed) return;
    dock.hidden = jobs.length === 0;
    bubble.hidden = jobs.length === 0 || dismissed;
    if (!jobs.length) return;
    const active = jobs.filter(pending);
    const completed = jobs.filter(ready);
    const latest = active[0] ?? jobs[0];
    const summary = active.length
      ? `${active.length === 1 ? '1 video' : `${active.length} videos`} · ${statusText(latest).toLowerCase()}`
      : latest.status === 'failed' || latest.status === 'submission_unknown' ? statusText(latest)
      : completed.length ? `${completed.length} ${completed.length === 1 ? 'video' : 'videos'} ready` : statusText(latest);
    const state = connectionError ? `${summary} · Reconnecting…` : summary;
    const status = h('button.video-dock-status', { type: 'button', title: `Open ${latest.title || 'capture'}` },
      h('span.video-status-dot', { class: active.length ? 'is-active' : latest.status === 'failed' ? 'is-failed' : '' }),
      h('span', h('strong', 'Videos'), h('span.video-dock-message', state)),
    );
    status.addEventListener('click', () => { void openJob(latest); });
    const thumbs = h('div.video-dock-thumbs', { 'aria-label': 'Completed videos' });
    for (const job of completed) {
      const button = h('button.video-dock-thumb', { type: 'button', title: `${job.title} · ${job.prompt}`, 'aria-label': `Open video: ${job.title}` },
        h('span.video-thumb-title', job.title || 'Untitled'));
      button.addEventListener('click', () => { void openJob(job); });
      thumbs.append(button);
      addThumbnail(button, job);
    }
    dock.replaceChildren(status, thumbs);
    const bubbleOpen = h('button.video-bubble-open', { type: 'button', 'aria-label': state, title: state },
      videoIcon(), h('span', active.length ? `${active.length} generating` : latest.status === 'failed' ? 'Video failed' : latest.status === 'submission_unknown' ? 'Check video' : completed.length ? `${completed.length} ready` : 'Video update'),
    );
    bubbleOpen.classList.toggle('is-active', active.length > 0);
    bubbleOpen.addEventListener('click', () => { void openJob(latest); });
    const dismiss = h('button.video-bubble-dismiss', { type: 'button', 'aria-label': 'Dismiss video status', title: 'Dismiss video status' }, '×');
    dismiss.addEventListener('click', () => { dismissed = true; bubble.hidden = true; });
    bubble.replaceChildren(bubbleOpen, dismiss);
    const announcement = jobs.map((job) => `${job.id}:${job.status}`).join('|');
    if (announcement !== lastAnnouncement) {
      lastAnnouncement = announcement;
      live.textContent = state;
    }
  }

  function notify() {
    renderDock();
    for (const render of subscribers) render();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (disposed) return;
    pollTimer = window.setTimeout(() => { void refresh(); }, jobs.some(pending) || connectionError ? 4000 : 15000);
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (fetching) return fetching;
    clearTimeout(pollTimer);
    const startedRevision = submissionRevision;
    const knownAtStart = new Set(jobs.map((job) => job.id));
    fetching = api.videos(worldId).then((records) => {
      if (disposed) return;
      const priorIds = new Set(jobs.map((job) => job.id));
      if (loaded && records.some((job) => !priorIds.has(job.id))) dismissed = false;
      loaded = true;
      // A list request already in flight when Action returns may precede that newly saved job.
      // Keep those local confirmations until the next list has had a chance to include them.
      const confirmedSinceStart = submissionRevision !== startedRevision
        ? jobs.filter((job) => !knownAtStart.has(job.id) && !records.some((record) => record.id === job.id)) : [];
      jobs = [...records, ...confirmedSinceStart].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      connectionError = '';
      notify();
    }).catch((error: unknown) => {
      if (disposed) return;
      connectionError = error instanceof Error ? error.message : 'Could not check video status.';
      notify();
    }).finally(() => { fetching = null; schedulePoll(); });
    return fetching;
  }

  function mountEditor(slide: SlideDoc, container: HTMLElement, editorOptions: VideoEditorOptions = {}): VideoEditor {
    let gone = false;
    let submitting = false;
    let selectedId = '';
    let manualSelection = false;
    let player: HTMLVideoElement | null = null;
    let renderedPreview = '';
    let notice = '';
    let noticeError = false;
    let title = slide.title;
    let savedCaption = slide.caption ?? '';
    let pendingRequest: { prompt: string; title: string; id: string } | null = null;
    let lastVariants = '';
    const draftKey = `wom:video-prompt:${worldId}:${slide.id}`;
    const requestKey = `${draftKey}:request`;
    const canEdit = () => editable && editorOptions.editable !== false && !archivedSources.has(slide.id);
    const source = editorOptions.previewUrl || slide.image.url;
    const preview = h('div.video-preview');
    const promptId = `video-prompt-${crypto.randomUUID()}`;
    const nameCount = h('span.video-character-count', { id: `${promptId}-title-count` });
    const promptCount = h('span.video-character-count', { id: `${promptId}-count` });
    // HTML maxlength counts UTF-16 units; two units per character leaves room for 120 / 16,000 emoji.
    // The Unicode-character and serialized-input checks below apply the actual limits.
    const name = h('input.video-name', { type: 'text', maxLength: MAX_SLIDE_TITLE_CHARS * 2, value: title, 'aria-label': 'Capture title', 'aria-describedby': nameCount.id, autocomplete: 'off' }) as HTMLInputElement;
    const prompt = h('textarea.video-prompt', { id: promptId, rows: 3, maxLength: MAX_VIDEO_PROMPT_CHARS * 2, placeholder: 'Describe how this image should move…', 'aria-label': 'Video motion prompt', 'aria-describedby': promptCount.id }) as HTMLTextAreaElement;
    let draft: string | null = null;
    try {
      if (canEdit()) {
        draft = localStorage.getItem(draftKey);
        const savedRequest = JSON.parse(localStorage.getItem(requestKey) || 'null') as unknown;
        if (savedRequest && typeof savedRequest === 'object' && 'id' in savedRequest && 'prompt' in savedRequest && 'title' in savedRequest
          && typeof savedRequest.id === 'string' && typeof savedRequest.prompt === 'string' && typeof savedRequest.title === 'string') {
          pendingRequest = { id: savedRequest.id, prompt: savedRequest.prompt, title: savedRequest.title };
        }
      }
    } catch { /* Storage can be disabled. */ }
    prompt.value = draft ?? savedCaption;
    let hasLocalDraft = draft !== null;
    let promptDirty = false;
    const editorId = `${promptId}-editor`;
    const expand = h('button.video-expand', { type: 'button', 'aria-expanded': 'false', 'aria-controls': editorId, title: 'Expand capture editor' }, 'Expand view');
    const action = h('button.video-action.primary', { type: 'button' }, 'Action') as HTMLButtonElement;
    const status = h('p.video-editor-status', { role: 'status', 'aria-live': 'polite' });
    const variants = h('div.video-variants', { 'aria-label': 'Videos from this capture', tabIndex: 0 });
    const el = h('section.video-editor', { id: editorId }, preview,
      editorOptions.showTitle === false ? null : h('div.video-name-row', name, nameCount),
      h('div.video-prompt-heading', h('label', { for: promptId }, 'Motion prompt'), h('span.video-prompt-tools', promptCount, expand)), prompt,
      h('div.video-action-row', h('span.video-model', 'H3 Max · 5 sec'), action), status, variants,
    );
    listenLocally(el);
    container.append(el);
    const setNotice = (message: string, error = false) => { notice = message; noticeError = error; render(); };
    const rememberPrompt = () => {
      hasLocalDraft = true;
      try { localStorage.setItem(draftKey, prompt.value); } catch { /* Optional draft cache. */ }
    };
    const stopPlayer = () => {
      if (player) { player.pause(); player.removeAttribute('src'); player.load(); player = null; }
    };

    function choose(job: VideoGeneration | undefined) {
      selectedId = job?.id ?? '';
      manualSelection = true;
      render();
    }
    function renderPreview(selected: VideoGeneration | undefined) {
      const firstFrame = selected?.sourceImageUrl || source;
      const key = selected && ready(selected) ? `${selected.id}:${selected.videoUrl}:${firstFrame}` : 'source';
      if (key === renderedPreview) return;
      stopPlayer();
      renderedPreview = key;
      const image = h('img.video-source', { src: firstFrame, alt: `${title}: first frame for this video`, draggable: false });
      preview.replaceChildren(image);
      if (selected && ready(selected)) {
        const play = h('button.video-play', { type: 'button', 'aria-label': `Play video: ${selected.title}` }, videoIcon());
        play.addEventListener('click', () => {
          if (gone || !selected.videoUrl) return;
          manualSelection = true;
          player = h('video.video-player', { src: selected.videoUrl, controls: true, playsInline: true, preload: 'metadata', poster: firstFrame }) as HTMLVideoElement;
          const playback = player;
          preview.replaceChildren(playback);
          void playback.play().catch(() => { /* Native controls remain available if autoplay is denied. */ });
        });
        preview.append(play);
      } else {
        preview.append(h('span.video-first-frame', 'First frame'));
      }
    }
    function render() {
      if (gone || disposed) return;
      const related = jobs.filter((job) => job.slideId === slide.id);
      const completed = related.filter(ready);
      if (!manualSelection && completed[0]) selectedId = completed[0].id;
      const selected = related.find((job) => job.id === selectedId);
      if (!canEdit()) {
        // Shared viewers see the selected clip's actual prompt, never this device's private drafts.
        prompt.value = (selected ?? related[0])?.prompt ?? slide.caption ?? '';
      } else if (!hasLocalDraft && !promptDirty) {
        // A new device has no local prompt cache, especially for the original photo. History still
        // carries the exact words used for each take, so opening one is useful without retyping them.
        prompt.value = manualSelection && selected ? selected.prompt : savedCaption || related[0]?.prompt || '';
      }
      renderPreview(selected);
      name.readOnly = !canEdit() || slide.kind === 'photo';
      name.title = name.readOnly ? title : 'Rename this capture';
      prompt.readOnly = !canEdit();
      const titleLength = characterCount(name.value);
      const promptLength = characterCount(prompt.value);
      const titleTooLong = titleLength > MAX_SLIDE_TITLE_CHARS;
      const promptCharsTooLong = promptLength > MAX_VIDEO_PROMPT_CHARS;
      const promptBytesTooLong = videoInputBytes(prompt.value) > MAX_VIDEO_INPUT_BYTES;
      nameCount.hidden = name.readOnly;
      nameCount.textContent = `${titleLength} / ${MAX_SLIDE_TITLE_CHARS}`;
      promptCount.textContent = `${promptLength.toLocaleString('en-US')} / ${MAX_VIDEO_PROMPT_CHARS.toLocaleString('en-US')}`;
      name.setAttribute('aria-invalid', String(titleTooLong));
      prompt.setAttribute('aria-invalid', String(promptCharsTooLong || promptBytesTooLong));
      action.hidden = !canEdit();
      action.disabled = submitting || !prompt.value.trim() || titleTooLong || promptCharsTooLong || promptBytesTooLong;
      action.textContent = submitting ? 'Sending…' : 'Action';
      const current = related.find(pending);
      const latest = related[0];
      const issue = latest && (latest.status === 'failed' || latest.status === 'submission_unknown') ? latest : undefined;
      const validation = titleTooLong ? `Title must be at most ${MAX_SLIDE_TITLE_CHARS} characters.`
        : promptCharsTooLong ? `Motion prompt must be at most ${MAX_VIDEO_PROMPT_CHARS.toLocaleString('en-US')} characters.`
        : promptBytesTooLong ? 'Motion prompt exceeds the 16 KiB input limit. Some characters take more space; shorten the prompt.' : '';
      let message = validation || notice || (current ? statusText(current) : issue?.error || (issue ? statusText(issue) : selected?.error || (selected ? statusText(selected) : 'Your image is the first frame. Describe what happens next.')));
      if (connectionError) message = `${message} · Status unavailable, reconnecting…`;
      status.textContent = message;
      status.classList.toggle('is-error', !!validation || noticeError || !!issue || selected?.status === 'failed' || selected?.status === 'submission_unknown');
      const signature = JSON.stringify([selectedId, title, completed.map((job) => [job.id, job.title, job.thumbnailUrl])]);
      if (signature !== lastVariants) {
        lastVariants = signature;
        variants.replaceChildren();
        variants.hidden = !completed.length;
        if (completed.length) {
          const original = h('button.video-original', { type: 'button', title: `${title} · Original first frame`, 'aria-label': `Show the original first frame: ${title}`, 'aria-pressed': String(!selectedId) },
            h('img', { src: slide.image.thumb || source, alt: '', draggable: false }), h('span.video-thumb-title', title));
          original.addEventListener('click', () => choose(undefined));
          variants.append(original);
        }
        for (const [index, job] of completed.entries()) {
          const button = h('button.video-variant', { type: 'button', title: `${job.title} · ${job.prompt}`, 'aria-label': `Select video ${completed.length - index}: ${job.title}`, 'aria-pressed': String(job.id === selectedId) },
            h('span.video-thumb-title', job.title || 'Untitled'));
          button.addEventListener('click', () => choose(job));
          variants.append(button);
          addThumbnail(button, job);
        }
      }
    }

    prompt.addEventListener('input', () => { promptDirty = true; rememberPrompt(); notice = ''; noticeError = false; render(); });
    prompt.addEventListener('blur', () => {
      if (gone || !canEdit() || slide.kind !== 'view' || characterCount(prompt.value) > MAX_VIDEO_PROMPT_CHARS || videoInputBytes(prompt.value) > MAX_VIDEO_INPUT_BYTES) return;
      const wanted = prompt.value;
      if (wanted === savedCaption) return;
      savedCaption = wanted;
      void api.updateSlide(worldId, slide.id, { caption: wanted }).then((updated) => {
        if (gone) return;
        slide.caption = updated.caption;
        if (prompt.value === wanted) savedCaption = updated.caption ?? '';
      }).catch(() => {
        if (gone) return;
        savedCaption = slide.caption ?? '';
        setNotice('Prompt kept on this device. Could not save it to the capture.', true);
      });
    });
    prompt.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canEdit()) { event.preventDefault(); action.click(); }
    });
    expand.addEventListener('click', () => {
      const expanded = el.classList.toggle('is-expanded');
      expand.setAttribute('aria-expanded', String(expanded));
      expand.textContent = expanded ? 'Compact view' : 'Expand view';
      expand.title = expanded ? 'Collapse capture editor' : 'Expand capture editor';
      prompt.rows = expanded ? 8 : 3;
      prompt.focus();
    });
    name.addEventListener('input', () => { notice = ''; noticeError = false; render(); });
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); name.blur(); }
      if (event.key === 'Escape') { name.value = title; name.blur(); }
    });
    name.addEventListener('change', () => {
      const wanted = name.value.trim();
      if (characterCount(name.value) > MAX_SLIDE_TITLE_CHARS) { render(); return; }
      if (!canEdit() || !wanted || wanted === title) { name.value = title; render(); return; }
      void api.updateSlide(worldId, slide.id, { title: wanted }).then((updated) => {
        if (gone) return;
        title = updated.title;
        slide.title = updated.title;
        if (name.value.trim() === wanted) name.value = title;
        render();
      }).catch((error: unknown) => {
        if (gone) return;
        name.value = title;
        setNotice(error instanceof Error ? error.message : 'Could not rename this capture.', true);
      });
    });
    action.addEventListener('click', async () => {
      const motion = prompt.value.trim();
      if (gone || submitting || !canEdit() || !motion || characterCount(name.value) > MAX_SLIDE_TITLE_CHARS || characterCount(prompt.value) > MAX_VIDEO_PROMPT_CHARS || videoInputBytes(prompt.value) > MAX_VIDEO_INPUT_BYTES) return;
      rememberPrompt();
      const wantedTitle = name.value.trim() || title;
      // Keep the same id after an uncertain response. Only a confirmed success starts another generation.
      if (!pendingRequest || pendingRequest.prompt !== motion || pendingRequest.title !== wantedTitle) {
        pendingRequest = { prompt: motion, title: wantedTitle, id: crypto.randomUUID() };
      }
      try { localStorage.setItem(requestKey, JSON.stringify(pendingRequest)); } catch { /* In-memory deduplication still works. */ }
      submitting = true;
      notice = 'Submitting video…';
      noticeError = false;
      render();
      try {
        const job = await api.generateVideo(worldId, { slideId: slide.id, prompt: motion, title: wantedTitle, requestId: pendingRequest.id });
        if (disposed) return;
        pendingRequest = null;
        try { localStorage.removeItem(requestKey); } catch { /* Optional cache. */ }
        submissionRevision++;
        jobs = [job, ...jobs.filter((existing) => existing.id !== job.id)];
        dismissed = false;
        notice = '';
        manualSelection = false;
        notify();
        void refresh();
      } catch (error: unknown) {
        if (disposed) return;
        notice = error instanceof Error ? error.message : 'Could not confirm the submission. Check the status before trying again.';
        noticeError = true;
        // A failed response may still have created a job. GET is safe; never resubmit in the background.
        void refresh();
      } finally {
        submitting = false;
        render();
      }
    });
    const editor: VideoEditor = {
      el,
      setTitle(next) { title = next; slide.title = next; name.value = next; render(); },
      selectVideo(id) { selectedId = id; manualSelection = true; render(); },
      dispose() {
        if (gone) return;
        gone = true;
        stopPlayer();
        subscribers.delete(render);
        editors.delete(editor);
        el.remove();
      },
    };
    editors.add(editor);
    subscribers.add(render);
    render();
    return editor;
  }

  void refresh();
  return {
    mountEditor, open, refresh,
    setEditable(value) { editable = value; for (const render of subscribers) render(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(pollTimer);
      closeDialog();
      for (const editor of [...editors]) editor.dispose();
      for (const cancel of [...cancelThumbnails]) cancel();
      subscribers.clear();
      dock.remove(); bubble.remove(); live.remove();
    },
  };
}
