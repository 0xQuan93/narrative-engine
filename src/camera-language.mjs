/** Compile operator-intent moves into the episode's absolute-frame camera path.
 * Moves are cumulative, non-overlapping, and have explicit holds between them.
 * The matching focus path follows camera depth for a face at world z≈0.
 */
export function compileCameraMoves({base,durationFrames,moves,focusOffset=0.01}) {
  if(!Number.isSafeInteger(durationFrames)||durationFrames<2)throw new Error('Camera duration must contain at least two frames');
  if(!Array.isArray(moves)||moves.length<1||moves.length>12)throw new Error('Expected 1–12 camera moves');
  if(!base||!Array.isArray(base.position)||base.position.length!==3||!Array.isArray(base.target)||base.target.length!==3||!Number.isFinite(base.fov))throw new Error('Invalid base camera pose');
  if(!Number.isFinite(focusOffset)||Math.abs(focusOffset)>1)throw new Error('Invalid focus offset');
  const pose={position:[...base.position],target:[...base.target],fov:base.fov};
  const key=(frame,easing='step')=>({frame,position:[...pose.position],target:[...pose.target],fov:pose.fov,easing});
  const motion=[key(0)];
  let end=0;
  for(const move of moves){
    if(!move||!Number.isSafeInteger(move.startFrame)||!Number.isSafeInteger(move.endFrame)
      ||move.startFrame<end||move.endFrame<=move.startFrame||move.endFrame>durationFrames)throw new Error('Camera moves must be ordered, non-overlapping, and within the shot');
    if(!['linear','easeInOutQuad','easeOutCubic'].includes(move.easing))throw new Error('Unsupported camera move easing');
    const delta=move.delta;
    if(!delta||!Array.isArray(delta.position)||delta.position.length!==3||!Array.isArray(delta.target)||delta.target.length!==3||!Number.isFinite(delta.fov)
      ||[...delta.position,...delta.target].some(v=>!Number.isFinite(v)))throw new Error('Invalid camera move delta');
    if(move.startFrame>motion.at(-1).frame)motion.push(key(move.startFrame,move.easing));
    else motion.at(-1).easing=move.easing;
    for(let i=0;i<3;i++){pose.position[i]+=delta.position[i];pose.target[i]+=delta.target[i];}
    pose.fov+=delta.fov;
    if(pose.fov<=0||pose.fov>=85||Math.hypot(...pose.position.map((v,i)=>v-pose.target[i]))<0.1)throw new Error('Camera move produced an invalid pose');
    motion.push(key(move.endFrame));
    end=move.endFrame;
  }
  if(motion.at(-1).frame<durationFrames)motion.push(key(durationFrames));
  if(motion.length>32)throw new Error('Camera path exceeds 32 episode keys');
  const focusMotion=motion.map(({frame,position,easing})=>({frame,focusDistance:+(position[2]+focusOffset).toFixed(4),easing}));
  return {motion,focusMotion};
}
