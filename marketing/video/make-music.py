#!/usr/bin/env python3
"""
Original background music for the amem explainer: 60 s, 120 BPM, synthesized from scratch with
numpy (no samples, no licences). Every scene change in index.html falls on a beat:

    0-9   the problem   soft pad and a filtered arpeggio, minor and a little uneasy
    9     meet amem     riser into an impact; drums and bass come in
    15-30 how it works  full groove
    30-41 savings       lift: brighter pad, claps, open hats
    41-52 activity      groove, with a fill into the end card
    52-60 call to act   resolve to C, drums drop at 58, tail fades out

    python3 make-music.py [out.wav]      (default: music.wav next to this file)
"""
import sys
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
BPM = 120
BEAT = 60 / BPM
LENGTH = 60.0
N = int(SR * LENGTH)
rng = np.random.default_rng(7)

left = np.zeros(N)
right = np.zeros(N)
send = np.zeros(N)  # reverb bus (mono)


def hz(note):
    """MIDI note number to frequency."""
    return 440.0 * 2 ** ((note - 69) / 12)


def place(sig, start, gain=1.0, pan=0.0, rev=0.0):
    i = int(start * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    left[i : i + len(sig)] += sig * gain * l * 1.414
    right[i : i + len(sig)] += sig * gain * r * 1.414
    send[i : i + len(sig)] += sig * gain * rev


def env(n, attack, release, sustain_level=1.0):
    e = np.ones(n) * sustain_level
    a = min(n, int(attack * SR))
    r = min(n - a, int(release * SR))
    if a:
        e[:a] = np.linspace(0, sustain_level, a)
    if r:
        e[n - r :] = np.linspace(sustain_level, 0, r) * (e[n - r] / max(sustain_level, 1e-9))
    return e


def lowpass(sig, cutoff):
    return sosfilt(butter(2, cutoff, "low", fs=SR, output="sos"), sig)


def bandpass(sig, lo, hi):
    return sosfilt(butter(2, [lo, hi], "band", fs=SR, output="sos"), sig)


def highpass(sig, cutoff):
    return sosfilt(butter(2, cutoff, "high", fs=SR, output="sos"), sig)


# --- harmony: Am7, Fmaj7, Cmaj7, G6, two bars (4 s) each ------------------------------------
CHORDS = [
    [57, 60, 64, 67],  # Am7
    [53, 57, 60, 64],  # Fmaj7
    [48, 55, 59, 64],  # Cmaj7
    [55, 59, 62, 64],  # G6
]
ROOTS = [45, 41, 36, 43]


def chord_at(t):
    return (int(t // (8 * BEAT))) % 4


def pad_note(freq, dur, bright):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for det in (-0.07, 0.0, 0.07):  # three slightly detuned voices
        f = freq * 2 ** (det / 12)
        for h, amp in ((1, 1.0), (2, 0.35 * bright), (3, 0.18 * bright), (4, 0.08 * bright)):
            sig += amp * np.sin(2 * np.pi * f * h * t + rng.uniform(0, 6.28))
    sig *= 1 + 0.15 * np.sin(2 * np.pi * 0.25 * t)  # slow movement
    return sig * env(n, 1.2, 1.6) / 6


def pad(start, end, bright, gain):
    t = start
    while t < end - 0.01:
        c = chord_at(t)
        seg_end = min(end, (int(t // (8 * BEAT)) + 1) * 8 * BEAT)
        dur = seg_end - t + 1.4  # overlap into the next chord
        for i, note in enumerate(CHORDS[c]):
            place(pad_note(hz(note), dur, bright), t, gain, pan=(-0.5 + i / 3), rev=0.5)
        t = seg_end


def pluck(freq, dur=0.5, cutoff=3000):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * freq * t) + 0.4 * np.sin(2 * np.pi * freq * 2 * t) + 0.15 * np.sign(np.sin(2 * np.pi * freq * t))
    sig *= np.exp(-t * 9)
    return lowpass(sig, cutoff) * env(n, 0.003, 0.05)


def arp(start, end, gain, cutoff):
    pattern = [0, 1, 2, 3, 2, 1, 3, 2]
    step = BEAT / 2
    k = 0
    t = start
    while t < end - 0.01:
        notes = CHORDS[chord_at(t)]
        note = notes[pattern[k % 8]] + 12
        place(pluck(hz(note), cutoff=cutoff * 1.4), t, gain * 1.5 * (1.0 if k % 2 == 0 else 0.7), pan=0.35 if k % 2 else -0.35, rev=0.35)
        # dotted-eighth echo, quieter, other side
        place(pluck(hz(note), cutoff=cutoff * 0.6), t + 0.75 * BEAT, gain * 0.3, pan=-0.6 if k % 2 else 0.6, rev=0.4)
        k += 1
        t += step


def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 45 + 75 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7)


def hat(open_=False):
    n = int((0.22 if open_ else 0.05) * SR)
    t = np.arange(n) / SR
    return highpass(rng.standard_normal(n), 6000) * np.exp(-t * (14 if open_ else 60)) * 1.3


def clap():
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    burst = bandpass(rng.standard_normal(n), 900, 2600)
    e = np.exp(-t * 18)
    for d in (0.0, 0.012, 0.024):  # the flam that makes a clap
        e += np.exp(-np.clip(t - d, 0, None) * 60) * (t >= d) * 0.6
    return burst * e * 0.9


def bass_note(freq, dur):  # mixed under the kick
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * freq * t) + 0.25 * np.sin(2 * np.pi * freq * 2 * t)
    return lowpass(sig, 400) * env(n, 0.01, 0.08) * 0.75


def drums(start, end, claps=False, open_hats=False, kick_gain=0.9):
    t = start
    i = int(round(start / (BEAT / 2)))
    while t < end - 0.01:
        if i % 2 == 0:  # on the beat
            place(kick(), t, kick_gain)
            if claps and (i // 2) % 2 == 1:
                place(clap(), t, 0.5, pan=0.05, rev=0.25)
        else:  # off-beat hats
            place(hat(open_hats and (i // 2) % 2 == 1), t, 0.35 if open_hats else 0.28, pan=0.25)
        place(hat(), t + BEAT / 4, 0.12, pan=-0.25)
        i += 1
        t = i * BEAT / 2


def bass(start, end, gain):
    t = start
    while t < end - 0.01:
        root = ROOTS[chord_at(t)]
        place(bass_note(hz(root), BEAT * 0.45), t, gain)
        place(bass_note(hz(root + 12 if int(t / BEAT) % 4 == 3 else root), BEAT * 0.3), t + BEAT * 0.5, gain * 0.6)
        t += BEAT


def riser(end, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    sweep = np.zeros(n)
    hop = 2048
    for j in range(0, n, hop):  # filter sweep, 300 Hz to 6 kHz
        cut = 300 * (20 ** (j / n))
        sweep[j : j + hop] = bandpass(noise[j : j + hop], cut, min(cut * 2.2, 18000))
    sig = sweep * (t / dur) ** 2
    place(sig * 0.35, end - dur, 1.0, rev=0.4)


def impact(at, gain=1.0):
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * (38 + 40 * np.exp(-t * 10)) * t) * np.exp(-t * 2.2)
    air = highpass(rng.standard_normal(n), 3000) * np.exp(-t * 5) * 0.15
    place((boom + air) * gain, at, 0.9, rev=0.6)


# --- arrangement -----------------------------------------------------------------------------
pad(0.0, 9.0, bright=0.4, gain=0.55)
arp(1.0, 9.0, gain=0.22, cutoff=1400)
riser(9.0, 3.0)
impact(9.0)

pad(9.0, 30.0, bright=0.7, gain=0.5)
arp(9.0, 30.0, gain=0.28, cutoff=2600)
bass(9.0, 30.0, gain=0.55)
drums(9.0, 29.5, kick_gain=0.8)
riser(30.0, 2.0)

pad(30.0, 41.0, bright=1.0, gain=0.55)
arp(30.0, 41.0, gain=0.32, cutoff=4200)
bass(30.0, 41.0, gain=0.6)
drums(30.0, 41.0, claps=True, open_hats=True)

pad(41.0, 52.0, bright=0.8, gain=0.5)
arp(41.0, 51.5, gain=0.3, cutoff=3200)
bass(41.0, 51.5, gain=0.55)
drums(41.0, 51.0, claps=True)
for k in range(4):  # fill into the end card
    place(clap(), 51.0 + k * BEAT / 4, 0.25 + 0.1 * k, rev=0.3)
riser(52.0, 1.5)
impact(52.0, 0.8)

# end card: resolve on C major, drums to 58, then the tail
for i, note in enumerate([48, 55, 60, 64, 67]):
    place(pad_note(hz(note), 8.0, 0.9), 52.0, 0.5, pan=(-0.6 + i * 0.3), rev=0.6)
arp(52.0, 57.0, gain=0.25, cutoff=3600)
bass(52.0, 58.0, gain=0.5)
drums(52.0, 58.0, open_hats=True, kick_gain=0.75)
place(pluck(hz(72), dur=2.5, cutoff=5000), 58.0, 0.35, rev=0.8)

# --- reverb: exponentially decaying noise as an impulse response ------------------------------
ir_len = int(2.4 * SR)
ir_t = np.arange(ir_len) / SR
ir = rng.standard_normal(ir_len) * np.exp(-ir_t * 2.6)
ir = lowpass(ir, 6000)
ir /= np.sqrt(np.sum(ir**2))
wet = fftconvolve(send, ir)[:N] * 0.9
left += wet
right += np.roll(wet, int(0.013 * SR))  # a touch of width

# --- master: fades, peak at -1 dBFS ----------------------------------------------
mix = np.stack([left, right])
mix /= np.max(np.abs(mix))  # no saturation; render.mjs sets the final loudness (-16 LUFS)
fade = np.ones(N)
fade[: int(0.3 * SR)] = np.linspace(0, 1, int(0.3 * SR))
fade[int(57.0 * SR) :] = np.linspace(1, 0, N - int(57.0 * SR)) ** 1.5
mix *= fade
mix *= 10 ** (-1 / 20) / np.max(np.abs(mix))

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("music.wav")
pcm = (mix.T * 32767).astype("<i2")
with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f"Wrote {out} ({LENGTH:.0f} s, {BPM} BPM)")
