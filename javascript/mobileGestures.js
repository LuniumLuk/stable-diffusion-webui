/**
 * Shared multi-touch gesture helpers (mobile/tablet).
 *
 * The webui canvases were built around a mouse (wheel zoom, right-button pan,
 * hover handles).  This module provides reusable two-finger pinch/pan and
 * double-tap recognizers so every canvas can behave like a native mobile
 * image editor:
 *
 *   mobileGestures.attachPinch(element, handlers, opts)
 *   mobileGestures.attachDoubleTap(element, handler, opts)
 *   mobileGestures.isCoarsePointer()
 *
 * attachPinch handlers receive a context object:
 *   {
 *     phase: "start" | "move" | "end",
 *     scale,          // distance(start) -> distance(now), 1 at gesture start
 *     prevScale,      // value of `scale` on the previous move
 *     dx, dy,         // midpoint movement since gesture start (client px)
 *     prevDx, prevDy, // previous frame values
 *     centerX, centerY,      // current midpoint (client px)
 *     startCenterX/Y,        // midpoint at gesture start
 *     points: [{x, y}, ...], // current touch points (client px)
 *     cancelled,      // true when the gesture ended via touchcancel
 *   }
 *
 * The helper only claims gestures that start with >= 2 fingers; single-finger
 * interaction (drawing, dragging) is left to the host.  While a gesture is
 * active the helper calls preventDefault() so the page neither scrolls nor
 * zooms.  attachDoubleTap only fires for quick single-finger taps without
 * movement.
 */
(function () {
  "use strict";

  if (window.mobileGestures) return;

  function isCoarsePointer() {
    try {
      return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    } catch (e) {
      return false;
    }
  }

  function distance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function midpoint(a, b) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  function defaultAllowed(event) {
    return true;
  }

  /**
   * Two-finger pinch + pan recognizer.
   *
   * opts.filter(event) -> boolean      called on touchstart; return false to
   *                                    ignore the gesture entirely (e.g. touch
   *                                    began on a toolbar).
   * opts.touchAction === false         do not force touch-action:none
   * opts.capture === true              register listeners in the capture phase
   *                                    (keeps working when another capture
   *                                    handler calls stopPropagation)
   * opts.minTouches                    fingers needed to start (default 2)
   */
  function attachPinch(target, handlers, opts) {
    if (!target) return null;
    opts = opts || {};
    handlers = handlers || {};

    const minTouches = opts.minTouches || 2;
    const filter = typeof opts.filter === "function" ? opts.filter : defaultAllowed;
    const forceTouchAction = opts.touchAction !== false;
    const listenerOpts = { passive: false, capture: !!opts.capture };

    const touches = new Map();
    let gesture = null;
    let blocked = false; // gesture refused by filter / minTouches

    if (forceTouchAction) {
      try {
        target.style.touchAction = "none";
      } catch (e) {
        /* ignore */
      }
    }

    function points() {
      return Array.from(touches.values());
    }

    function snapshot(phase, event, cancelled) {
      const pts = points();
      const center = pts.length >= 2 ? midpoint(pts[0], pts[1]) : { x: gesture.centerX, y: gesture.centerY };
      return {
        phase,
        scale: gesture.scale,
        prevScale: gesture.prevScale,
        dx: gesture.dx,
        dy: gesture.dy,
        prevDx: gesture.prevDx,
        prevDy: gesture.prevDy,
        centerX: center.x,
        centerY: center.y,
        startCenterX: gesture.startCenterX,
        startCenterY: gesture.startCenterY,
        points: pts.map((p) => ({ x: p.clientX, y: p.clientY })),
        cancelled: !!cancelled,
        event: event || null,
      };
    }

    function emit(phase, event, cancelled) {
      const handler = phase === "start" ? handlers.onStart : phase === "move" ? handlers.onMove : handlers.onEnd;
      if (typeof handler !== "function") return;
      try {
        handler(snapshot(phase, event, cancelled));
      } catch (err) {
        console.error("[mobileGestures] pinch handler failed", err);
      }
    }

    function startGesture(event) {
      const pts = points();
      const center = midpoint(pts[0], pts[1]);
      gesture = {
        startDist: Math.max(1, distance(pts[0], pts[1])),
        startCenterX: center.x,
        startCenterY: center.y,
        centerX: center.x,
        centerY: center.y,
        scale: 1,
        prevScale: 1,
        dx: 0,
        dy: 0,
        prevDx: 0,
        prevDy: 0,
      };
      emit("start", event, false);
    }

    function updateGesture() {
      const pts = points();
      if (pts.length < 2) return;
      const center = midpoint(pts[0], pts[1]);
      gesture.prevScale = gesture.scale;
      gesture.prevDx = gesture.dx;
      gesture.prevDy = gesture.dy;
      gesture.scale = Math.max(1, distance(pts[0], pts[1])) / gesture.startDist;
      gesture.dx = center.x - gesture.startCenterX;
      gesture.dy = center.y - gesture.startCenterY;
      gesture.centerX = center.x;
      gesture.centerY = center.y;
    }

    function endGesture(event, cancelled) {
      if (gesture) {
        updateGesture();
        emit("end", event, cancelled);
      }
      gesture = null;
      blocked = false;
    }

    target.addEventListener(
      "touchstart",
      (event) => {
        for (const t of event.changedTouches) {
          touches.set(t.identifier, { clientX: t.clientX, clientY: t.clientY });
        }
        if (gesture) {
          event.preventDefault();
          return;
        }
        if (touches.size >= minTouches) {
          if (!filter(event)) {
            blocked = true;
            return;
          }
          startGesture(event);
          event.preventDefault();
        }
      },
      listenerOpts
    );

    target.addEventListener(
      "touchmove",
      (event) => {
        let changed = false;
        for (const t of event.changedTouches) {
          if (touches.has(t.identifier)) {
            touches.set(t.identifier, { clientX: t.clientX, clientY: t.clientY });
            changed = true;
          }
        }
        if (gesture && changed) {
          updateGesture();
          if (gesture) {
            emit("move", event, false);
            event.preventDefault();
          }
        } else if (blocked) {
          // swallow the move so the page does not scroll from a refused gesture
          event.preventDefault();
        }
      },
      listenerOpts
    );

    function finish(event, cancelled) {
      for (const t of event.changedTouches) {
        touches.delete(t.identifier);
      }
      if (gesture && touches.size < minTouches) {
        endGesture(event, cancelled);
        if (event.cancelable) event.preventDefault();
      } else if (!gesture && touches.size === 0) {
        blocked = false;
      }
    }

    target.addEventListener("touchend", (event) => finish(event, false), listenerOpts);
    target.addEventListener("touchcancel", (event) => finish(event, true), listenerOpts);

    return {
      isActive: () => !!gesture,
      abort: () => {
        if (gesture) emit("end", null, true);
        gesture = null;
        blocked = false;
      },
    };
  }

  /**
   * Double-tap recognizer (single finger, quick, no movement).
   * handler({ clientX, clientY, event }).
   */
  function attachDoubleTap(target, handler, opts) {
    if (!target || typeof handler !== "function") return null;
    opts = opts || {};
    const maxDelay = opts.maxDelay || 320;
    const maxMove = opts.maxMove || 14;
    const maxGap = opts.maxGap || 34;

    let lastTap = null; // { time, x, y }
    let firstTouch = null;

    target.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length !== 1) {
          firstTouch = null;
          return;
        }
        const t = event.touches[0];
        firstTouch = { x: t.clientX, y: t.clientY, time: Date.now() };
      },
      { passive: true }
    );

    target.addEventListener(
      "touchend",
      (event) => {
        if (!firstTouch || event.changedTouches.length !== 1) {
          firstTouch = null;
          return;
        }
        const t = event.changedTouches[0];
        const moved = Math.hypot(t.clientX - firstTouch.x, t.clientY - firstTouch.y);
        const elapsed = Date.now() - firstTouch.time;
        firstTouch = null;
        if (moved > maxMove || elapsed > maxDelay) {
          lastTap = null;
          return;
        }

        const now = Date.now();
        if (lastTap && now - lastTap.time <= maxDelay && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) <= maxGap) {
          lastTap = null;
          try {
            handler({ clientX: t.clientX, clientY: t.clientY, event: event });
          } catch (err) {
            console.error("[mobileGestures] double-tap handler failed", err);
          }
          return;
        }
        lastTap = { time: now, x: t.clientX, y: t.clientY };
      },
      { passive: true }
    );
  }

  window.mobileGestures = {
    attachPinch,
    attachDoubleTap,
    isCoarsePointer,
  };
})();
