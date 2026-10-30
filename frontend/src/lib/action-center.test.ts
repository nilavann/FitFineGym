import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  getActionCenterWindow,
  getRelativeExpiryLabel,
  splitActionCenterQueue,
  useActionCenterCount,
} from './action-center';
import type { MemberListRepository } from '../repositories/member-list.repository';
import { buildMemberListRow } from '../test/builders';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 5, 27, 12, 0)); // 27 Jun 2026
});
afterEach(() => {
  vi.useRealTimers();
});

describe('getActionCenterWindow', () => {
  it('spans 12 months back to 30 days ahead of local today', () => {
    expect(getActionCenterWindow()).toEqual({ from: '2025-06-27', to: '2026-07-27' });
  });
});

describe('splitActionCenterQueue', () => {
  it('splits on today: upcoming keeps order, expired is reversed (most recently expired first)', () => {
    const soon = buildMemberListRow({ current_membership_end_date: '2026-06-28' });
    const later = buildMemberListRow({ current_membership_end_date: '2026-07-10' });
    const lapsedLong = buildMemberListRow({ current_membership_end_date: '2026-01-05' });
    const lapsedRecent = buildMemberListRow({ current_membership_end_date: '2026-06-20' });

    // Repository order is ascending by end date.
    const { upcoming, expired } = splitActionCenterQueue([lapsedLong, lapsedRecent, soon, later]);

    expect(upcoming).toEqual([soon, later]);
    expect(expired).toEqual([lapsedRecent, lapsedLong]);
  });

  it('counts a membership ending today as upcoming, not expired', () => {
    const today = buildMemberListRow({ current_membership_end_date: '2026-06-27' });
    expect(splitActionCenterQueue([today])).toEqual({ upcoming: [today], expired: [] });
  });

  it('drops indefinite memberships (no end date) from both queues', () => {
    const indefinite = buildMemberListRow({ current_membership_end_date: null });
    expect(splitActionCenterQueue([indefinite])).toEqual({ upcoming: [], expired: [] });
  });
});

describe('getRelativeExpiryLabel', () => {
  it.each([
    ['2026-06-27', 'Expires today', 'urgent'],
    ['2026-06-28', 'Expires tomorrow', 'urgent'],
    ['2026-07-04', 'Expires in 7 days', 'urgent'],
    ['2026-07-05', 'Expires in 8 days', 'soon'],
    ['2026-06-26', 'Expired 1 day ago', 'expired'],
    ['2026-05-13', 'Expired 45 days ago', 'expired'],
    ['2026-04-28', 'Expired 2 months ago', 'expired'], // 60 days -> switches to months
    ['2026-03-19', 'Expired 3 months ago', 'expired'], // 100 days
  ])('%s -> "%s" (%s)', (endDate, text, tier) => {
    expect(getRelativeExpiryLabel(endDate)).toEqual({ text, tier });
  });
});

describe('useActionCenterCount', () => {
  function fakeRepository(getActionCenterCount: MemberListRepository['getActionCenterCount']): MemberListRepository {
    return { getActionCenterCount } as unknown as MemberListRepository;
  }

  it('is null until the count loads, then the queue size', async () => {
    const repository = fakeRepository(vi.fn().mockResolvedValue(3));

    const { result } = renderHook(() => useActionCenterCount(repository));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(3));
  });

  it('asks the repository for the bounded Action Center window, never getAll()', async () => {
    const getActionCenterCount = vi.fn().mockResolvedValue(0);
    renderHook(() => useActionCenterCount(fakeRepository(getActionCenterCount)));
    await waitFor(() => expect(getActionCenterCount).toHaveBeenCalledTimes(1));
    expect(getActionCenterCount).toHaveBeenCalledWith({ from: '2025-06-27', to: '2026-07-27' });
  });

  it('fails silently (no badge) when the fetch rejects — navigation must never break', async () => {
    const getActionCenterCount = vi.fn().mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useActionCenterCount(fakeRepository(getActionCenterCount)));
    await waitFor(() => expect(getActionCenterCount).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('fetches again when the refresh key changes, keeping the old count until the new one arrives', async () => {
    const getActionCenterCount = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    const repository = fakeRepository(getActionCenterCount);
    const { result, rerender } = renderHook(({ key }) => useActionCenterCount(repository, key), { initialProps: { key: '/a' } });
    await waitFor(() => expect(result.current).toBe(3));

    rerender({ key: '/b' });
    expect(result.current).toBe(3);
    await waitFor(() => expect(result.current).toBe(2));
    expect(getActionCenterCount).toHaveBeenCalledTimes(2);
  });

  it('does not fetch again when it re-renders with the same refresh key', async () => {
    const getActionCenterCount = vi.fn().mockResolvedValue(1);
    const repository = fakeRepository(getActionCenterCount);
    const { rerender } = renderHook(({ key }) => useActionCenterCount(repository, key), { initialProps: { key: '/a' } });
    await waitFor(() => expect(getActionCenterCount).toHaveBeenCalledTimes(1));
    rerender({ key: '/a' });
    expect(getActionCenterCount).toHaveBeenCalledTimes(1);
  });

  it('does not set state after unmount', async () => {
    let resolve!: (total: number) => void;
    const pending = new Promise<number>((r) => (resolve = r));
    const { unmount } = renderHook(() => useActionCenterCount(fakeRepository(vi.fn().mockReturnValue(pending))));
    unmount();
    resolve(1);
    await pending; // the console.error guard (src/test/console.ts) fails the test on a stray React warning
  });
});
