import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATES, rate, rateEquals, rateFps, rateLabel, isDropFrameRate,
  frames, addFrames, scaleFrames, framesToSeconds, secondsToFrames, secondsToFramesFloor,
  toRationalTime, fromRationalTime,
  timeRange, rangeEnd, lastFrame, rangeContains, rangesOverlap, rangeIntersection,
  toTimecode, parseTimecode,
} from '../lib/time/frames.ts';

describe('rate is an exact rational, not a decimal', () => {
  test('23.976 and 24000/1001 are NOT the same rate', () => {
    // the pitfall the whole module exists for: these compare equal as
    // rounded decimals and are different rates
    assert.ok(!rateEquals(rate(23.976), RATES.ntscFilm));
    assert.equal(rateFps(RATES.ntscFilm).toFixed(3), '23.976');
  });

  test('equal rates in different forms compare equal', () => {
    assert.ok(rateEquals({ num: 48, den: 2 }, RATES.film));
    assert.ok(rateEquals(RATES.ntsc, { num: 60000, den: 2002 }));
  });

  test('drop-frame is detected from the denominator, not the decimal', () => {
    assert.ok(isDropFrameRate(RATES.ntsc));
    assert.ok(isDropFrameRate(RATES.ntscHigh));
    assert.ok(!isDropFrameRate(RATES.film));
    assert.ok(!isDropFrameRate(RATES.ntscFilm)); // 23.976 is not drop-frame
  });

  test('labels read the way editors say them', () => {
    assert.equal(rateLabel(RATES.film), '24 fps');
    assert.equal(rateLabel(RATES.ntsc), '29.97 fps');
  });
});

describe('frames are whole numbers', () => {
  test('a fractional frame is rejected at construction', () => {
    assert.throws(() => frames(10.5), /whole number/);
    assert.throws(() => frames(NaN), /whole number/);
  });

  test('arithmetic stays integral', () => {
    assert.equal(addFrames(frames(24), frames(12)), 36);
    assert.equal(scaleFrames(frames(100), 0.5), 50);
    assert.equal(scaleFrames(frames(101), 0.5), 51, 'rounds, never produces half a frame');
  });
});

describe('seconds conversion', () => {
  test('round-trips exactly at integer rates', () => {
    for (const f of [0, 1, 24, 1000, 86399]) {
      const back = secondsToFrames(framesToSeconds(frames(f), RATES.film), RATES.film);
      assert.equal(back, f);
    }
  });

  test('round-trips at NTSC rates, where naive float maths drifts', () => {
    for (const f of [1, 30, 1799, 108000]) {
      const back = secondsToFrames(framesToSeconds(frames(f), RATES.ntsc), RATES.ntsc);
      assert.equal(back, f, `frame ${f} did not survive a round trip at 29.97`);
    }
  });

  test('rounds to nearest, and floors when asked', () => {
    assert.equal(secondsToFrames(0.9999, RATES.film), 24);
    assert.equal(secondsToFramesFloor(0.9999, RATES.film), 23);
  });
});

describe('OTIO boundary', () => {
  test('a whole frame at the project rate passes through', () => {
    const rt = toRationalTime(frames(120), RATES.film);
    assert.deepEqual(rt, { value: 120, rate: 24 });
    assert.equal(fromRationalTime(rt, RATES.film), 120);
  });

  test('refuses a half frame instead of silently truncating it', () => {
    assert.throws(() => fromRationalTime({ value: 10.5, rate: 24 }, RATES.film), /not a whole frame/);
  });

  test('converts between rates only when it lands on a frame boundary', () => {
    // 48 frames at 48fps is exactly 24 frames at 24fps
    assert.equal(fromRationalTime({ value: 48, rate: 48 }, RATES.film), 24);
    // 49 frames at 48fps is 24.5 frames at 24fps, not representable
    assert.throws(() => fromRationalTime({ value: 49, rate: 48 }, RATES.film), /not a frame boundary/);
  });
});

describe('ranges are half-open', () => {
  const r = timeRange(frames(100), frames(50)); // [100, 150)

  test('the end frame is not inside the range', () => {
    assert.equal(rangeEnd(r), 150);
    assert.ok(rangeContains(r, frames(100)));
    assert.ok(rangeContains(r, frames(149)));
    assert.ok(!rangeContains(r, frames(150)), 'frame 150 belongs to the NEXT clip');
  });

  test('lastFrame is one before the end, and undefined when empty', () => {
    assert.equal(lastFrame(r), 149);
    assert.equal(lastFrame(timeRange(frames(5), frames(0))), undefined);
  });

  test('abutting clips do not overlap', () => {
    const next = timeRange(frames(150), frames(20));
    assert.ok(!rangesOverlap(r, next), 'a cut is not an overlap');
    assert.equal(rangeIntersection(r, next), null);
  });

  test('real overlaps intersect correctly', () => {
    const other = timeRange(frames(120), frames(60)); // [120, 180)
    assert.ok(rangesOverlap(r, other));
    assert.deepEqual(rangeIntersection(r, other), { start: 120, duration: 30 });
  });

  test('a negative duration is rejected', () => {
    assert.throws(() => timeRange(frames(10), frames(-1)), /negative/);
  });
});

describe('timecode', () => {
  test('non-drop is plain', () => {
    assert.equal(toTimecode(frames(0), RATES.film), '00:00:00:00');
    assert.equal(toTimecode(frames(24), RATES.film), '00:00:01:00');
    assert.equal(toTimecode(frames(24 * 3661 + 13), RATES.film), '01:01:01:13');
  });

  test('drop-frame marks itself with a semicolon and skips labels at minutes', () => {
    // 29.97 DF: 00:00:59;29 is followed by 00:01:00;02, labels :00 and :01 are dropped
    assert.equal(toTimecode(frames(1799), RATES.ntsc), '00:00:59;29');
    assert.equal(toTimecode(frames(1800), RATES.ntsc), '00:01:00;02');
  });

  test('the tenth minute does not drop', () => {
    // 17982 frames = exactly 10 minutes of 29.97 drop-frame
    assert.equal(toTimecode(frames(17982), RATES.ntsc), '00:10:00;00');
  });

  test('parses what a person would actually type', () => {
    assert.equal(parseTimecode('00:00:01:00', RATES.film), 24);
    assert.equal(parseTimecode('0:12', RATES.film), 288);
    assert.equal(parseTimecode('1:23.5', RATES.film), 2004);
    assert.equal(parseTimecode('12', RATES.film), 288);
    assert.equal(parseTimecode('later', RATES.film), null);
  });
});
