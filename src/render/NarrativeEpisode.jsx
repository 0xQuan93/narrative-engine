import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig,
  useDelayRender, useBufferState, useRemotionEnvironment} from 'remotion';
import {createStage} from './stage.mjs';
import {evaluateDialogueAtFrame} from '../dialogue.mjs';

const fonts = new Map();
function loadCaptionFont(url) {
  if (!fonts.has(url)) {
    const font = new FontFace('NarrativeCaption', `url("${url}")`, {weight: '700'});
    fonts.set(url, font.load().then((loaded) => { document.fonts.add(loaded); }));
  }
  return fonts.get(url);
}

export function CaptionOverlay({dialogue, frame, width, height}) {
  if (!dialogue) return null;
  const {caption, wordIndex} = evaluateDialogueAtFrame(dialogue, frame);
  if (!caption) return null;
  const portrait = width < height;
  return <div data-caption-id={caption.id} style={{position: 'absolute', bottom: portrait ? '20%' : '5.5%', left: portrait ? '14%' : '10%',
    width: portrait ? '72%' : '80%', display: 'flex', justifyContent: 'center', pointerEvents: 'none'}}>
    <div style={{fontFamily: 'NarrativeCaption, sans-serif', fontWeight: 700, fontSize: width * (portrait ? 0.043 : 0.033),
      lineHeight: 1.3, textAlign: 'center', color: '#f3f7f6', background: 'rgba(8,18,22,0.94)',
      padding: `${width * 0.012}px ${width * 0.025}px`, borderRadius: width * 0.012,
      border: '1px solid rgba(155,220,207,0.28)', boxShadow: '0 5px 18px rgba(0,0,0,0.3)'}}>
      {caption.words.map((word, i) => <React.Fragment key={`${caption.id}-${i}`}>
        {i > 0 ? ' ' : ''}<span style={{color: i === wordIndex ? '#91ecd2' : '#f3f7f6'}}>{word.text}</span>
      </React.Fragment>)}
    </div>
  </div>;
}

export function NarrativeEpisode({episode, assets, verifyFrameOrder = false, assetUrlPrefix, onReady, onError}) {
  const canvas = useRef(null);
  const frame = useCurrentFrame();
  const latestFrame = useRef(frame); latestFrame.current = frame;
  const callbacks = useRef({onReady, onError}); callbacks.current = {onReady, onError};
  const {width, height} = useVideoConfig();
  const {delayRender, continueRender, cancelRender} = useDelayRender();
  const {delayPlayback} = useBufferState();
  const environment = useRemotionEnvironment();
  const [handle] = useState(() => delayRender('Prepare locked VRM and caption font', {timeoutInMilliseconds: 120000}));
  const [stage, setStage] = useState(null);
  const [failure, setFailure] = useState(null);
  useEffect(() => {
    let disposed = false;
    let loaded;
    const playback = delayPlayback();
    const assetUrl = assetUrlPrefix === undefined ? staticFile : (file) => `${assetUrlPrefix}${file}`;
    const prepare = async () => {
      if (episode.dialogue) await loadCaptionFont(assetUrl('fonts/LiberationSans-Bold.ttf'));
      if (disposed) return;
      const value = await createStage({canvas: canvas.current, width, height, episode, assets, assetUrl});
      loaded = value;
      if (disposed) { value.dispose(); return; }
      if (verifyFrameOrder) console.info('NARRATIVE_FRAME_VERIFICATION ' + JSON.stringify(await value.verifyFrameOrder()));
      if (disposed) return;
      value.renderAtFrame(latestFrame.current);
      setStage(value);
      continueRender(handle);
      playback.unblock();
      callbacks.current.onReady?.();
    };
    prepare().catch((error) => {
      if (disposed) return;
      playback.unblock();
      continueRender(handle);
      setFailure(error.message);
      callbacks.current.onError?.(error);
      if (environment.isRendering) cancelRender(error);
    });
    return () => { disposed = true; loaded?.dispose(); playback.unblock(); continueRender(handle); };
  }, [width, height, episode, assets, verifyFrameOrder, assetUrlPrefix, handle, delayPlayback,
    continueRender, cancelRender, environment.isRendering]);
  useLayoutEffect(() => {
    if (stage) {
      try { stage.renderAtFrame(frame); } catch (error) {
        callbacks.current.onError?.(error);
        setFailure(error.message);
        if (environment.isRendering) cancelRender(error);
      }
    }
  }, [stage, frame, cancelRender, environment.isRendering]);
  return <AbsoluteFill style={{background: '#10191d'}}>
    <canvas ref={canvas} width={width} height={height} style={{width: '100%', height: '100%'}} />
    <CaptionOverlay dialogue={episode.dialogue} frame={frame} width={width} height={height} />
    {failure ? <AbsoluteFill style={{color: '#ffe1d7', padding: 40, font: '28px sans-serif', background: '#172125'}}>{failure}</AbsoluteFill> : null}
  </AbsoluteFill>;
}
