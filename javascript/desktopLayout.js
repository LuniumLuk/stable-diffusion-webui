// Desktop layout helpers:
//  - relocate the global quicksettings row (the checkpoint selector) into the
//    Generation parameter column of the active txt2img/img2img tab;
//  - keep the txt2img result panel pinned below the sticky top row.
(function () {
  "use strict";

  const CHECKPOINT_HOST_IDS = ["txt2img_checkpoint_host", "img2img_checkpoint_host"];

  let toprowObserver = null;

  function visibleCheckpointHost() {
    for (const id of CHECKPOINT_HOST_IDS) {
      const host = gradioApp().getElementById(id);
      if (host && host.offsetParent !== null) {
        return host;
      }
    }
    return null;
  }

  function moveCheckpointIntoParameters() {
    const quicksettings = gradioApp().getElementById("quicksettings");
    if (!quicksettings) return;

    const host = visibleCheckpointHost();
    if (host && quicksettings.parentElement !== host) {
      host.appendChild(quicksettings);
    }
  }

  function updateTxt2imgStickyOffset() {
    const toprow = gradioApp().getElementById("txt2img_toprow");
    if (!toprow) return;

    // When the txt2img tab is not active the sticky offset is irrelevant; keep
    // the last measured value so switching back does not flash at the wrong spot.
    const height = toprow.offsetHeight;
    if (height > 0) {
      document.documentElement.style.setProperty("--txt2img-results-top", `${height + 8}px`);
    }
  }

  function observeToprow() {
    const toprow = gradioApp().getElementById("txt2img_toprow");
    if (!toprow || !window.ResizeObserver) return;
    if (toprowObserver && toprowObserver.target === toprow) return;

    if (toprowObserver) {
      toprowObserver.observer.disconnect();
    }

    const observer = new ResizeObserver(updateTxt2imgStickyOffset);
    observer.observe(toprow);
    toprowObserver = { target: toprow, observer };
  }

  function applyLayout() {
    moveCheckpointIntoParameters();
    observeToprow();
    updateTxt2imgStickyOffset();
  }

  window.desktopLayoutUpdate = applyLayout;

  onUiLoaded(applyLayout);
  onAfterUiUpdate(applyLayout);
  window.addEventListener("resize", updateTxt2imgStickyOffset);

  // Inner/main tab switches change which checkpoint host is visible; Gradio
  // updates the visibility a tick after the click.
  document.addEventListener("click", function () {
    setTimeout(applyLayout, 60);
    setTimeout(applyLayout, 300);
  }, true);
})();
