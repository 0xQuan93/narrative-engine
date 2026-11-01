#!/usr/bin/env python3
"""Offline beat extract. Not imported by the renderer.

HPSS, percussive onset, beat track, kick energy below 150 Hz, downbeat
phase by mean kick energy. Prints a narrative-music/0.1 JSON object.
"""

import argparse
import json
import sys


def fail(message):
    print(message, file=sys.stderr)
    return 1


def main():
    parser = argparse.ArgumentParser(description='Extract episode-absolute beats from a local audio file')
    parser.add_argument('audio')
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--duration', type=float, default=20)
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--bpm', type=float, default=0)
    args = parser.parse_args()
    if args.fps < 1 or args.duration <= 0 or args.start < 0:
        return fail('fps, start, and duration must be positive')
    try:
        import numpy as np
        import librosa
    except ImportError:
        return fail('import-beats needs a local Python with librosa and numpy. Rendering does not.')
    try:
        audio, sample_rate = librosa.load(args.audio, sr=22050, mono=True, offset=args.start, duration=args.duration)
    except Exception as error:
        return fail(f'could not read audio: {error}')
    if audio.size < sample_rate * 0.25:
        return fail('audio slice is too short to track beats')
    _harmonic, percussive = librosa.effects.hpss(audio)
    onset = librosa.onset.onset_strength(y=percussive, sr=sample_rate)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset, sr=sample_rate, start_bpm=args.bpm or 150, units='frames')
    tempo_value = float(np.atleast_1d(tempo)[0])
    times = librosa.frames_to_time(beat_frames, sr=sample_rate)
    if len(times) < 2:
        return fail('beat tracker found fewer than two beats')
    spectrum = np.abs(librosa.stft(audio))
    frequencies = librosa.fft_frequencies(sr=sample_rate)
    band = np.where(frequencies <= 150)[0]
    kick = spectrum[band].mean(axis=0) if band.size else np.zeros(spectrum.shape[1])
    kick_times = librosa.frames_to_time(np.arange(kick.shape[0]), sr=sample_rate)
    strengths = []
    for beat_time in times:
        index = int(np.argmin(np.abs(kick_times - beat_time)))
        strengths.append(float(kick[index]))
    peak = max(strengths) or 1
    strengths = [max(0.0, min(1.0, value / peak)) for value in strengths]
    phase_scores = []
    for phase in range(4):
        chosen = strengths[phase::4]
        phase_scores.append(float(np.mean(chosen)) if chosen else 0)
    down_phase = int(np.argmax(phase_scores))
    beats = []
    previous = -1
    for index, beat_time in enumerate(times):
        frame = int(round(float(beat_time) * args.fps))
        if frame <= previous:
            continue
        previous = frame
        beats.append({
            'frame': frame,
            'strength': round(strengths[index], 4),
            'downbeat': (index - down_phase) % 4 == 0,
        })
    if len(beats) > 4096:
        return fail('more than 4096 beats; analyze a shorter slice')
    bpm = round(args.bpm, 2) if args.bpm else round(tempo_value, 2)
    print(json.dumps({
        'schema': 'narrative-music/0.1',
        'bpm': bpm,
        'offsetSeconds': args.start,
        'beats': beats,
        'sections': [{'frame': 0, 'label': 'groove', 'energy': 0.6}],
    }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
