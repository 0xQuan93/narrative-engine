#!/usr/bin/env python3
"""Offline beat extract. Not imported by the renderer.

HPSS, percussive onset, beat track, kick energy below 150 Hz, downbeat
phase by mean kick energy. Sections come from per-bar RMS and onset.
Prints a narrative-music/0.1 JSON object.

`label_sections` matches `labelSections` in src/music.mjs. Keep them together.
"""

import argparse
import json
import sys


def fail(message):
    print(message, file=sys.stderr)
    return 1


def clamp01(value):
    return max(0.0, min(1.0, float(value)))


def round3(value):
    return int(value * 1000 + (0.5 if value >= 0 else -0.5)) / 1000


def average(values):
    if not values:
        return 0.0
    return sum(values) / len(values)


def label_sections(bars):
    clean = []
    for bar in bars or []:
        frame = bar.get('frame', -1)
        if isinstance(frame, bool) or not isinstance(frame, int) or frame < 0:
            continue
        clean.append({
            'frame': frame,
            'energy': clamp01(bar.get('energy') or 0),
            'onset': clamp01(bar.get('onset') or 0),
        })
    clean.sort(key=lambda bar: bar['frame'])
    if not clean:
        return [{'frame': 0, 'label': 'groove', 'energy': 0.6}]
    if len(clean) < 4:
        return [{
            'frame': clean[0]['frame'],
            'label': 'groove',
            'energy': round3(average([bar['energy'] for bar in clean])),
        }]
    smooth = []
    for index, _bar in enumerate(clean):
        window = clean[max(0, index - 1):min(len(clean), index + 2)]
        smooth.append(average([item['energy'] for item in window]))
    sorted_energy = sorted(smooth)
    median = sorted_energy[(len(sorted_energy) - 1) // 2]
    high_cut = max(median * 1.18, sorted_energy[int(len(sorted_energy) * 0.7)])
    floor = median + 0.08
    high = [value >= high_cut and value >= floor for value in smooth]
    runs = []
    start = -1
    for index in range(len(high) + 1):
        if index < len(high) and high[index]:
            if start < 0:
                start = index
        elif start >= 0:
            if index - start >= 2:
                runs.append((start, index))
            start = -1
    sections = []

    def push(frame, label, energy):
        if sections and sections[-1]['label'] == label:
            return
        sections.append({'frame': frame, 'label': label, 'energy': round3(clamp01(energy))})

    quiet_end = runs[0][0] if runs else len(clean)
    if quiet_end > 0:
        push(0, 'groove', average([bar['energy'] for bar in clean[:quiet_end]]) or 0.6)
    peak_onset = max((bar['onset'] for bar in clean), default=0)
    for index, (start_index, end_index) in enumerate(runs):
        previous = clean[start_index - 1]['energy'] if start_index > 0 else clean[start_index]['energy']
        previous_onset = clean[start_index - 1]['onset'] if start_index > 0 else 0
        jump = clean[start_index]['energy'] - previous
        onset_jump = clean[start_index]['onset'] - previous_onset
        spiked = jump >= 0.28 and onset_jump >= 0.35 and clean[start_index]['onset'] >= max(0.01, peak_onset) * 0.75
        if index == 0:
            label = 'drop' if spiked else 'hook'
        else:
            label = 'drop' if jump >= 0.15 else 'hook'
        push(clean[start_index]['frame'], label, average([bar['energy'] for bar in clean[start_index:end_index]]))
    if runs:
        tail_start = runs[-1][1]
        if len(clean) - tail_start >= 2:
            tail = [bar['energy'] for bar in clean[tail_start:]]
            tail_energy = average(tail)
            if tail_energy <= median * 0.95:
                push(clean[tail_start]['frame'], 'outro', tail_energy)
    if not sections:
        return [{'frame': 0, 'label': 'groove', 'energy': 0.6}]
    if sections[0]['frame'] > 0:
        sections.insert(0, {'frame': 0, 'label': 'groove', 'energy': sections[0]['energy']})
    return sections


def sample_at(times, values, beat_time):
    index = int(abs(times - beat_time).argmin())
    return float(values[index])


def main():
    parser = argparse.ArgumentParser(description='Extract episode-absolute beats from a local audio file')
    parser.add_argument('audio', nargs='?')
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--duration', type=float, default=20)
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--bpm', type=float, default=0)
    parser.add_argument('--label-sections', default='', help='Read bar JSON and print sections. No audio or librosa.')
    args = parser.parse_args()
    if args.label_sections:
        with open(args.label_sections, encoding='utf-8') as handle:
            print(json.dumps(label_sections(json.load(handle))))
        return 0
    if not args.audio:
        return fail('audio path is required')
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
    hop = 512
    rms = librosa.feature.rms(y=audio, hop_length=hop)[0]
    rms_times = librosa.frames_to_time(np.arange(rms.shape[0]), sr=sample_rate, hop_length=hop)
    onset_times = librosa.times_like(onset, sr=sample_rate)
    beat_rms = [sample_at(rms_times, rms, beat_time) for beat_time in times]
    beat_onset = [sample_at(onset_times, onset, beat_time) for beat_time in times]
    rms_peak = max(beat_rms) or 1
    onset_peak = max(beat_onset) or 1
    beat_rms = [max(0.0, min(1.0, value / rms_peak)) for value in beat_rms]
    beat_onset = [max(0.0, min(1.0, value / onset_peak)) for value in beat_onset]
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
            'rms': beat_rms[index],
            'onset': beat_onset[index],
        })
    if len(beats) > 4096:
        return fail('more than 4096 beats; analyze a shorter slice')
    starts = [index for index, beat in enumerate(beats) if beat['downbeat']]
    if len(starts) < 4:
        sections = [{'frame': 0, 'label': 'groove', 'energy': 0.6}]
    else:
        bars = []
        for cursor, start in enumerate(starts):
            end = starts[cursor + 1] if cursor + 1 < len(starts) else len(beats)
            group = beats[start:end]
            if not group:
                continue
            bars.append({
                'frame': group[0]['frame'],
                'energy': average([beat['rms'] for beat in group]),
                'onset': average([beat['onset'] for beat in group]),
            })
        sections = label_sections(bars)
    for beat in beats:
        beat.pop('rms', None)
        beat.pop('onset', None)
        if not beat['downbeat']:
            beat.pop('downbeat')
    bpm = round(args.bpm, 2) if args.bpm else round(tempo_value, 2)
    print(json.dumps({
        'schema': 'narrative-music/0.1',
        'bpm': bpm,
        'offsetSeconds': args.start,
        'beats': beats,
        'sections': sections,
    }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
