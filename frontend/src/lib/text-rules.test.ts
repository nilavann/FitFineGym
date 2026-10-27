import { describe, expect, it } from 'vitest';
import { charLength, cleanText } from './text-rules';

describe('cleanText', () => {
  it('strips the characters the database’s *_text constraints reject, then trims', () => {
    // NUL, TAB, DEL, zero-width space, LRM, RLO (bidi override), word joiner, BOM.
    expect(cleanText(' A\u0000b\u0009c\u007fd​e‎f‮g⁠h﻿ ')).toBe('Abcdefgh');
  });

  it('keeps ZWNJ and ZWJ, which Indic scripts need in ordinary names', () => {
    expect(cleanText('क्‌ष')).toBe('क्‌ष');
    expect(cleanText('क्‍ष')).toBe('क्‍ष');
  });

  it('keeps line feeds only in a multi-line field, and drops a carriage return either way', () => {
    expect(cleanText('Flat 4\r\nMG Road', true)).toBe('Flat 4\nMG Road');
    expect(cleanText('Flat 4\r\nMG Road')).toBe('Flat 4MG Road');
  });

  it('drops a lone surrogate, which Postgres cannot store', () => {
    expect(cleanText('a\ud800b')).toBe('ab');
  });
});

describe('charLength', () => {
  it('counts code points as char_length does, not UTF-16 units', () => {
    expect('😀'.length).toBe(2);
    expect(charLength('😀')).toBe(1);
    expect(charLength('a'.repeat(80))).toBe(80);
  });
});
