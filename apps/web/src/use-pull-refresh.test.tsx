// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePullRefresh } from './use-pull-refresh.js';
import './test-setup.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function Harness({
  onRefresh,
  refreshing = false,
}: {
  onRefresh: () => Promise<void>;
  refreshing?: boolean;
}) {
  const pull = usePullRefresh({ onRefresh, refreshing });
  return (
    <div
      data-testid="container"
      data-distance={pull.pullDistance}
      data-armed={pull.armed}
      {...pull.containerProps}
    >
      <input aria-label="topic" />
    </div>
  );
}

function touch(target: Element, type: 'start' | 'move' | 'end', x: number, y: number) {
  const touches = type === 'end' ? [] : [{ clientX: x, clientY: y }];
  return fireEvent[type === 'start' ? 'touchStart' : type === 'move' ? 'touchMove' : 'touchEnd'](
    target,
    { touches, changedTouches: [{ clientX: x, clientY: y }], cancelable: true },
  );
}

describe('usePullRefresh', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  });

  it('registers a non-passive native move listener and removes it on unmount', () => {
    const addEventListener = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const removeEventListener = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const rendered = render(<Harness onRefresh={vi.fn(async () => undefined)} />);
    const registration = addEventListener.mock.calls.find(([type, _listener, options]) => (
      type === 'touchmove'
      && typeof options === 'object'
      && options !== null
      && (options as AddEventListenerOptions).passive === false
    ));

    expect(registration).toBeDefined();
    rendered.unmount();
    expect(removeEventListener).toHaveBeenCalledWith('touchmove', registration?.[1]);
  });

  it('arms above 72px, caps visual distance, and resets after async refresh', async () => {
    const pending = deferred();
    const onRefresh = vi.fn(() => pending.promise);
    const preventDefault = vi.spyOn(Event.prototype, 'preventDefault');
    render(<Harness onRefresh={onRefresh} />);
    const container = screen.getByTestId('container');

    touch(container, 'start', 20, 10);
    touch(container, 'move', 22, 210);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(Number(container.getAttribute('data-distance'))).toBeLessThanOrEqual(120);
    expect(container).toHaveAttribute('data-armed', 'true');
    touch(container, 'end', 22, 210);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(container).toHaveAttribute('data-armed', 'true');
    await act(async () => pending.resolve());
    expect(container).toHaveAttribute('data-distance', '0');
    expect(container).toHaveAttribute('data-armed', 'false');
  });

  it('ignores below-threshold, upward, horizontal, multi-touch, and form-control gestures', () => {
    const onRefresh = vi.fn(async () => undefined);
    const preventDefault = vi.spyOn(Event.prototype, 'preventDefault');
    render(<Harness onRefresh={onRefresh} />);
    const container = screen.getByTestId('container');
    const input = screen.getByLabelText('topic');

    touch(container, 'start', 10, 10);
    touch(container, 'move', 10, 82);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    touch(container, 'end', 10, 82);
    preventDefault.mockClear();
    touch(container, 'start', 10, 90);
    touch(container, 'move', 10, 10);
    touch(container, 'end', 10, 10);
    touch(container, 'start', 10, 10);
    touch(container, 'move', 100, 90);
    touch(container, 'end', 100, 90);
    fireEvent.touchStart(container, {
      touches: [{ clientX: 10, clientY: 10 }, { clientX: 20, clientY: 20 }],
    });
    fireEvent.touchMove(container, {
      touches: [{ clientX: 10, clientY: 100 }, { clientX: 20, clientY: 110 }],
    });
    fireEvent.touchEnd(container, { touches: [] });
    touch(input, 'start', 10, 10);
    touch(input, 'move', 10, 100);
    touch(input, 'end', 10, 100);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('requires the page top and does not duplicate refresh while busy', async () => {
    const pending = deferred();
    const onRefresh = vi.fn(() => pending.promise);
    const preventDefault = vi.spyOn(Event.prototype, 'preventDefault');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 10 });
    const { rerender } = render(<Harness onRefresh={onRefresh} />);
    const container = screen.getByTestId('container');

    touch(container, 'start', 10, 10);
    touch(container, 'move', 10, 100);
    touch(container, 'end', 10, 100);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    touch(container, 'start', 10, 10);
    touch(container, 'move', 10, 100);
    touch(container, 'end', 10, 100);
    touch(container, 'start', 10, 10);
    touch(container, 'move', 10, 100);
    touch(container, 'end', 10, 100);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve());
    rerender(<Harness onRefresh={onRefresh} refreshing />);
    touch(container, 'start', 10, 10);
    touch(container, 'move', 10, 100);
    touch(container, 'end', 10, 100);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('resets without an unhandled rejection when refresh fails', async () => {
    const onRefresh = vi.fn(async () => { throw new Error('offline'); });
    render(<Harness onRefresh={onRefresh} />);
    const container = screen.getByTestId('container');

    touch(container, 'start', 10, 10);
    touch(container, 'move', 10, 100);
    touch(container, 'end', 10, 100);
    await act(async () => Promise.resolve());

    expect(container).toHaveAttribute('data-distance', '0');
    expect(container).toHaveAttribute('data-armed', 'false');
  });
});
