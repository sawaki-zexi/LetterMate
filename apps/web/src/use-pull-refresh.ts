import { useCallback, useRef, useState, type TouchEventHandler } from 'react';

const triggerDistance = 72;
const maximumDistance = 120;

interface PullRefreshOptions {
  onRefresh: () => Promise<void>;
  refreshing?: boolean;
}

interface PullRefreshContainerProps {
  onTouchStart: TouchEventHandler<HTMLElement>;
  onTouchMove: TouchEventHandler<HTMLElement>;
  onTouchEnd: TouchEventHandler<HTMLElement>;
  onTouchCancel: TouchEventHandler<HTMLElement>;
}

interface GestureState {
  active: boolean;
  armed: boolean;
  startX: number;
  startY: number;
}

function isFormControl(target: EventTarget | null): boolean {
  return Boolean(
    target
    && 'closest' in target
    && typeof target.closest === 'function'
    && target.closest('input, textarea, select, button, [contenteditable="true"], [contenteditable=""]'),
  );
}

export function usePullRefresh({
  onRefresh,
  refreshing = false,
}: PullRefreshOptions): {
  containerProps: PullRefreshContainerProps;
  pullDistance: number;
  armed: boolean;
} {
  const gesture = useRef<GestureState>({ active: false, armed: false, startX: 0, startY: 0 });
  const refreshingRef = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [armed, setArmed] = useState(false);

  const reset = useCallback(() => {
    gesture.current.active = false;
    gesture.current.armed = false;
    setPullDistance(0);
    setArmed(false);
  }, []);

  const onTouchStart = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    if (
      refreshing
      || refreshingRef.current
      || window.scrollY !== 0
      || event.touches.length !== 1
      || isFormControl(event.target)
    ) {
      reset();
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    gesture.current = {
      active: true,
      armed: false,
      startX: touch.clientX,
      startY: touch.clientY,
    };
  }, [refreshing, reset]);

  const onTouchMove = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    if (!gesture.current.active) return;
    if (event.touches.length !== 1 || window.scrollY !== 0) {
      reset();
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    const deltaX = touch.clientX - gesture.current.startX;
    const deltaY = touch.clientY - gesture.current.startY;
    if (deltaY <= 0 || Math.abs(deltaX) >= deltaY) {
      reset();
      return;
    }

    if (event.cancelable) event.preventDefault();
    const distance = Math.min(deltaY, maximumDistance);
    const isArmed = deltaY > triggerDistance;
    gesture.current.armed = isArmed;
    setPullDistance(distance);
    setArmed(isArmed);
  }, [reset]);

  const onTouchEnd = useCallback<TouchEventHandler<HTMLElement>>(() => {
    if (!gesture.current.active || !gesture.current.armed || refreshing || refreshingRef.current) {
      reset();
      return;
    }
    gesture.current.active = false;
    refreshingRef.current = true;
    void (async () => {
      try {
        await onRefresh();
      } catch {
        // The refresh owner reports the failure; this hook only owns gesture state.
      } finally {
        refreshingRef.current = false;
        reset();
      }
    })();
  }, [onRefresh, refreshing, reset]);

  return {
    containerProps: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: reset,
    },
    pullDistance,
    armed,
  };
}
