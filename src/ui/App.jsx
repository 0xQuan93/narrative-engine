import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Player} from '@remotion/player';
import {NarrativeEpisode} from '../render/NarrativeEpisode.jsx';
import {createScriptEpisode, DEFAULT_SCRIPT_SETTINGS} from '../script-project.mjs';
import {evaluateDialogueAtFrame} from '../dialogue.mjs';

const defaults = {...DEFAULT_SCRIPT_SETTINGS, text: ''};
const same = (a, b) => JSON.stringify({...DEFAULT_SCRIPT_SETTINGS, ...a}) === JSON.stringify({...DEFAULT_SCRIPT_SETTINGS, ...b});
const timestamp = (frame, fps = 30) => `${Math.floor(frame / fps / 60)}:${String(Math.floor(frame / fps) % 60).padStart(2, '0')}`;
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const post = (settings) => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({settings})});

class PreviewBoundary extends React.Component {
  state = {error: null};
  static getDerivedStateFromError(error) { return {error}; }
  componentDidCatch(error) { this.props.onError?.(error); }
  render() {
    return this.state.error ? <div className="preview-error" role="alert"><strong>Preview could not load</strong><p>{this.state.error.message}</p><p>Apply your changes to try again.</p></div> : this.props.children;
  }
}

export default function App() {
  const [bootstrap, setBootstrap] = useState(null);
  const [settings, setSettings] = useState(defaults);
  const [saved, setSaved] = useState(null);
  const [applied, setApplied] = useState(null);
  const [project, setProject] = useState(null);
  const [revision, setRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [frame, setFrame] = useState(0);
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [job, setJob] = useState(null);
  const [jobSettings, setJobSettings] = useState(null);
  const player = useRef(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const prepare = useCallback((data, next) => {
    const built = createScriptEpisode({baseEpisode: data.baseEpisode, wave: data.wave, idle: data.idle, settings: next});
    const episode = built.episode ?? built;
    return {episode, captions: episode.dialogue?.captions ?? []};
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api('/api/bootstrap', {signal: controller.signal}).then((data) => {
      const next = {...defaults, ...data.settings};
      let prepared = null;
      try { prepared = prepare(data, next); }
      catch (err) { setError(`Saved draft needs a preview edit: ${err.message}`); }
      setBootstrap(data); setSettings(next); setSaved(next); setApplied(prepared ? next : null); setProject(prepared); setBusy('');
      if (data.latest) { setJob(data.latest); setJobSettings(data.latest.settings ?? null); }
    }).catch((err) => { if (err.name !== 'AbortError') { setError(err.message); setBusy(''); } });
    return () => controller.abort();
  }, [prepare]);

  useEffect(() => {
    const element = player.current;
    if (!element) return;
    const update = (event) => setFrame(event.detail.frame);
    element.addEventListener('frameupdate', update);
    return () => element.removeEventListener('frameupdate', update);
  }, [revision, project]);

  useEffect(() => {
    if (!job?.id || !['running', 'queued', 'pending'].includes(job.status)) return;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const result = await api(`/api/jobs/${encodeURIComponent(job.id)}`, {signal: controller.signal});
        if (controller.signal.aborted) return;
        setJob({...result, id: job.id});
        if (result.status === 'failed') setError(result.error || 'Rendering failed. Your draft is still available.');
        if (['running', 'queued', 'pending'].includes(result.status)) timer = setTimeout(poll, 1000);
      } catch (err) {
        if (err.name !== 'AbortError') {
          setJob((previous) => ({...previous, status: 'disconnected'}));
          setError(`Lost connection to the render. ${err.message}`);
        }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status]);

  const changed = applied && !same(settings, applied);
  const unsaved = saved && !same(settings, saved);
  const rendering = Boolean(job && ['running', 'queued', 'pending'].includes(job.status));
  const locked = Boolean(busy) || rendering;
  const words = settings.text.trim() ? settings.text.trim().split(/\s+/u).length : 0;
  const cueWords = settings.text.trim() ? settings.text.trim().split(/\s+/u) : [];
  const scriptSections = settings.text.trim() ? settings.text.trim().split(/\n\s*\n/u).map((section) => section.trim()).filter(Boolean) : [];
  const portrait = ((applied ?? settings).format ?? 'landscape') === 'portrait';
  const duration = project ? project.episode.durationFrames / project.episode.fps : 0;
  const captions = project?.captions ?? [];
  const currentCaption = project?.episode.dialogue ? evaluateDialogueAtFrame(project.episode.dialogue, frame).caption : null;
  const onReady = useCallback(() => { setPreviewFailed(false); setReady(true); }, []);
  const onPreviewError = useCallback((err) => { setReady(false); setPreviewFailed(true); setError(err?.message || String(err)); }, []);
  const inputProps = useMemo(() => project && ({episode: project.episode, assets: bootstrap.assets,
    assetUrlPrefix: '/', onReady, onError: onPreviewError}), [project, bootstrap, onReady, onPreviewError]);
  const update = (name, value) => { setSettings((previous) => ({...previous, [name]: value})); setNotice(''); };
  const updateShotCamera = (index, value) => {
    setSettings((previous) => {
      const shotCameras = [...(previous.shotCameras ?? [])];
      for (let i = shotCameras.length; i <= index; i++) shotCameras[i] = ['wide', 'medium', 'close'][i % 3];
      shotCameras[index] = value;
      return {...previous, shotCameras};
    });
    setNotice('');
  };

  function applyPreview() {
    try {
      setError('');
      const prepared = prepare(bootstrap, settings);
      player.current?.pause(); setReady(false); setPreviewFailed(false); setFrame(0); setProject(prepared); setApplied({...settings}); setRevision((value) => value + 1);
      setNotice('Preview updated.');
    } catch (err) { setError(err.message); }
  }
  async function saveDraft() {
    setBusy('saving'); setError(''); setNotice('');
    try { await api('/api/save', post(settings)); if (active.current) { setSaved({...settings}); setNotice('Draft saved on this computer.'); } }
    catch (err) { if (active.current) setError(err.message); }
    finally { if (active.current) setBusy(''); }
  }
  async function renderVideo() {
    setBusy('starting'); setError(''); setNotice('');
    try {
      const result = await api('/api/render', post(settings));
      if (active.current) { setJob(result); setJobSettings({...settings}); }
    } catch (err) { if (active.current) setError(err.message); }
    finally { if (active.current) setBusy(''); }
  }

  return <div className="studio-shell">
    <header className="topbar"><a href="/" className="brand" aria-label="Narrative Studio home"><span className="brand-mark" aria-hidden="true">N</span>Narrative <span>Studio</span></a><span className="local-badge"><i />Local workspace</span></header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">SCRIPT TO SCENE</p><h1>A small stage for your story.</h1><p className="intro">Write a script, shape the performance, and bring your avatar into the frame.</p></div><span className="mode-badge">Silent video</span></div>
      {error && <div className="message error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      <div className="studio-grid">
        <section className="panel editor-panel" aria-labelledby="script-heading">
          <div className="section-heading"><h2 id="script-heading"><span className="section-number">01</span>Your script</h2><span className="save-state">{unsaved ? 'Unsaved changes' : 'Draft ready'}</span></div>
          <label className="sr-only" htmlFor="script">Script text</label>
          <textarea id="script" value={settings.text} onChange={(event) => update('text', event.target.value)} disabled={locked || !bootstrap} maxLength={4000} spellCheck placeholder="Give your character something to say…" />
          <div className="text-meta"><span>{words} words</span><span>{settings.text.length.toLocaleString()} characters</span></div>
          <p className="helper">Text sets the estimated pacing and mouth movement. Up to 90 seconds, rendered without speech or music.</p>
          <div className="section-heading performance-heading"><h2><span className="section-number">02</span>Performance</h2></div>
          <fieldset disabled={locked || !bootstrap} className="controls"><legend className="sr-only">Performance settings</legend>
            <div className="control"><div className="label-row"><label htmlFor="pace">Reading pace</label><output htmlFor="pace">{settings.wordsPerMinute} <span>words/min</span></output></div><input id="pace" type="range" min="80" max="240" step="5" value={settings.wordsPerMinute} onChange={(event) => update('wordsPerMinute', Number(event.target.value))} /><div className="range-labels"><span>Unhurried</span><span>Brisk</span></div></div>
            <div className="control"><div className="label-row"><label htmlFor="mouth">Mouth movement</label><output htmlFor="mouth">{Math.round(settings.mouthStrength * 100)}%</output></div><input id="mouth" type="range" min="0" max="1" step="0.05" value={settings.mouthStrength} onChange={(event) => update('mouthStrength', Number(event.target.value))} /></div>
            <div className="select-row"><label htmlFor="motion">Movement<select id="motion" value={settings.motion} onChange={(event) => update('motion', event.target.value)}><option value="wave-idle">PoseLab · Wave + idle</option><option value="idle">PoseLab · Idle</option></select></label><label htmlFor="camera">Camera<select id="camera" value={settings.camera} onChange={(event) => update('camera', event.target.value)}><option value="cuts">Camera cuts</option><option value="medium">Medium shot</option><option value="close">Close-up</option><option value="directed">Directed take</option><option value="storyboard">Storyboard · script sections</option></select></label></div>
            <div className="select-row format-row"><label htmlFor="format">Frame format<select id="format" value={settings.format ?? 'landscape'} onChange={(event) => update('format', event.target.value)}><option value="landscape">Landscape · 1280 × 720</option><option value="portrait">Portrait · 720 × 1280</option></select></label></div>
            {settings.camera === 'directed' && <div className="direction-controls"><label htmlFor="reveal-word">Reveal cue<select id="reveal-word" value={settings.revealWordIndex ?? ''} onChange={(event) => update('revealWordIndex', event.target.value === '' ? null : Number(event.target.value))}><option value="">Automatic · middle of script</option>{cueWords.map((word, index) => <option value={index} key={index}>{index + 1}. {word}</option>)}</select></label><p>The lens creeps toward this word, then pushes in after it. The camera holds before a partial release. Depth blur and gentle handheld motion follow the take.</p></div>}
            {settings.camera === 'storyboard' && <div className="direction-controls storyboard-controls"><p>Separate 2–8 script sections with blank lines. Each section becomes a camera shot while PoseLab movement continues across cuts.</p>{scriptSections.slice(0, 8).map((section, index) => <label htmlFor={`shot-camera-${index}`} key={index}><span>Shot {index + 1} · {section.slice(0, 48)}{section.length > 48 ? '…' : ''}</span><select id={`shot-camera-${index}`} value={settings.shotCameras?.[index] ?? ['wide', 'medium', 'close'][index % 3]} onChange={(event) => updateShotCamera(index, event.target.value)}><option value="wide">Wide</option><option value="medium">Medium</option><option value="close">Close-up</option></select></label>)}{(scriptSections.length < 2 || scriptSections.length > 8) && <p className="section-warning">Add {scriptSections.length < 2 ? 'another blank-line section' : 'fewer sections'} before applying.</p>}</div>}
          </fieldset>
          <div className="editor-actions"><button className="button primary" type="button" onClick={applyPreview} disabled={locked || !bootstrap || !words}>Apply to preview <span aria-hidden="true">↗</span></button><button className="button secondary" type="button" onClick={saveDraft} disabled={locked || !bootstrap || !words}>{busy === 'saving' ? 'Saving…' : 'Save draft'}</button></div>
          <p className="editor-status" role="status">{changed ? 'Changes are waiting. Apply them before rendering.' : notice || 'Adjust freely, then apply when you’re ready.'}</p>
        </section>
        <div className="preview-column">
          <section className="panel preview-panel" aria-labelledby="preview-heading">
            <div className="section-heading"><h2 id="preview-heading"><span className="section-number">03</span>Scene preview</h2><span className="preview-meta">{duration ? `${duration.toFixed(1)} sec · 30 fps · ${portrait ? 'portrait' : 'landscape'}` : 'Preparing scene'}</span></div>
            <div className={`player-wrap ${portrait ? 'portrait' : ''}`}>
              {project && <PreviewBoundary key={revision} onError={onPreviewError}><Player key={revision} ref={player} component={NarrativeEpisode} inputProps={inputProps} durationInFrames={project.episode.durationFrames} compositionWidth={portrait ? 720 : 1280} compositionHeight={portrait ? 1280 : 720} fps={project.episode.fps} controls style={{width: portrait ? 'min(100%, 360px)' : '100%', aspectRatio: portrait ? '9 / 16' : '16 / 9'}} clickToPlay doubleClickToFullscreen showVolumeControls={false} /></PreviewBoundary>}
              {!project && bootstrap && <div className="loading-stage" role="status"><strong>Draft awaiting preview</strong><span>Edit the script, then apply when it is ready.</span></div>}
              {(!bootstrap || project && !ready) && !previewFailed && <div className="loading-stage" role="status"><span className="loading-orbit" /><strong>{bootstrap ? 'Preparing your scene' : 'Opening your workspace'}</strong><span>Loading the character and performance…</span></div>}
              {previewFailed && <div className="preview-error" role="alert"><strong>Preview could not load</strong><p>Apply your script again to retry.</p></div>}
              {changed && <span className="preview-pending">Preview has unapplied changes</span>}
            </div>
            <div className="caption-now"><span className="caption-label">CURRENT LINE</span><p>{currentCaption?.text || (ready ? 'Press play to preview the performance.' : 'Your scene will appear here.')}</p></div>
          </section>
          <section className="panel sequence-panel" aria-labelledby="sequence-heading"><div className="section-heading"><h2 id="sequence-heading">Script timeline</h2><span className="preview-meta">{captions.length} {captions.length === 1 ? 'line' : 'lines'}</span></div><div className="caption-list">{captions.length ? captions.map((caption, index) => <button type="button" key={`${index}-${caption.startFrame}`} className={`caption-item ${currentCaption?.id === caption.id ? 'is-current' : ''}`} aria-current={currentCaption?.id === caption.id ? 'true' : undefined} disabled={!ready || locked} onClick={() => { player.current?.seekTo(caption.startFrame); setFrame(caption.startFrame); }}><span className="caption-time">{timestamp(caption.startFrame, project.episode.fps)}</span><span>{caption.text}</span><span className="caption-seek" aria-hidden="true">↗</span></button>) : <p className="empty-timeline">Apply a script to see its timed lines.</p>}</div></section>
          <section className="panel export-panel" aria-labelledby="export-heading"><div><h2 id="export-heading">Ready for the next take?</h2><p>Render a {portrait ? '720 × 1280' : '1280 × 720'} silent MP4 of the applied scene.</p></div><button className="button primary render-button" type="button" onClick={renderVideo} disabled={locked || !ready || changed || !words}>{rendering ? 'Rendering…' : busy === 'starting' ? 'Starting…' : 'Render video'}<span aria-hidden="true">↓</span></button>
            {rendering && <div className="render-status" role="status"><span className="status-dot" />Rendering on this computer. You can leave this tab open.</div>}
            {job?.status === 'disconnected' && <div className="render-status"><button type="button" className="text-button" onClick={() => { setError(''); setJob((old) => ({...old, status: 'running'})); }}>Reconnect to render status</button></div>}
            {job?.status === 'completed' && <div className="render-result"><div className="result-heading"><span className="success-label">Render complete</span>{jobSettings && !same(jobSettings, settings) && <span className="preview-meta">From an earlier draft</span>}<div className="result-links">{job.videoUrl && <a href={job.videoUrl} download>Download MP4 ↗</a>}{job.srtUrl && <a href={job.srtUrl} download>Captions SRT ↗</a>}{job.vttUrl && <a href={job.vttUrl} download>Captions VTT ↗</a>}{job.receiptUrl && <a href={job.receiptUrl} target="_blank" rel="noreferrer">Render receipt ↗</a>}</div></div>{job.videoUrl && <video src={job.videoUrl} controls preload="metadata" aria-label="Rendered video" />}</div>}
          </section>
        </div>
      </div>
      <footer>YOUR CHARACTER. YOUR WORDS. YOUR NEXT SCENE.<span>Built for local creation.</span></footer>
    </main>
  </div>;
}
