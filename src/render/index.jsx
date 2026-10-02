import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {NarrativeEpisode} from './NarrativeEpisode.jsx';
import {validateEpisode} from '../episode.mjs';
import proof from '../../out/setup/first-take.json';
import assetLock from '../../assets.lock.json';

function Root() {
  return <Composition id="NarrativeEpisode" component={NarrativeEpisode}
    width={1280} height={720} fps={30} durationInFrames={360}
    defaultProps={{episode: proof, assets: assetLock.assets}}
    calculateMetadata={({props}) => {
      validateEpisode(props.episode);
      return {durationInFrames: props.episode.durationFrames, fps: props.episode.fps,
        width: props.width ?? 1280, height: props.height ?? 720};
    }} />;
}
registerRoot(Root);
