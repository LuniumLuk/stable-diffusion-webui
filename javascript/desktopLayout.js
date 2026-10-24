// Desktop layout helpers:
//  - relocate the global quicksettings row (the checkpoint selector) into the
//    Generation parameter column of the active txt2img/img2img tab;
//  - size the two column generation layout to the height left in the viewport,
//    so the parameter column scrolls on its own and the preview stays in place;
//  - fit the output gallery grid to the preview area.
(function () {
  "use strict";

  // resizeHandle.js stacks the two columns below this width
  const STACKED_LAYOUT_WIDTH = 704;

  const CHECKPOINT_HOST_IDS = ["txt2img_checkpoint_host", "img2img_checkpoint_host"];
  const GENERATION_ROW_IDS = ["txt2img_generation_row", "img2img_generation_row"];
  const GALLERY_IDS = ["txt2img_gallery", "img2img_gallery"];

  const galleryObservers = new Map();
  let layoutScheduled = false;

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

  function setPanelHeight(rows, height) {
    const value = height === null ? "" : `${height}px`;

    for (const row of rows) {
      if (row.style.getPropertyValue("--generation-panel-height") === value) continue;

      if (height === null) {
        row.style.removeProperty("--generation-panel-height");
      } else {
        row.style.setProperty("--generation-panel-height", value);
      }
    }
  }

  function fitGenerationRows() {
    const rows = GENERATION_ROW_IDS.map((id) => gradioApp().getElementById(id)).filter(Boolean);

    // only the generation tab of the current main tab can be measured; the
    // hidden row gets the same height so it is correct when it is shown
    const visible = rows.find((row) => row.offsetParent !== null);
    if (!visible) return;

    if (window.innerWidth < STACKED_LAYOUT_WIDTH) {
      setPanelHeight(rows, null);
      return;
    }

    const rowRect = visible.getBoundingClientRect();
    const rowTop = rowRect.top + window.scrollY;
    let reserved = 0;

    const footer = gradioApp().getElementById("footer");
    if (footer) {
      // gap, footer and the page's bottom padding are all laid out below the
      // row, so they do not depend on the height the row is about to get
      const footerRect = footer.getBoundingClientRect();
      const footerTop = footerRect.top + window.scrollY;
      const footerBottom = footerRect.bottom + window.scrollY;
      const docHeight = document.documentElement.scrollHeight;

      reserved += Math.max(0, footerTop - (rowRect.bottom + window.scrollY));
      reserved += footerRect.height;
      reserved += Math.max(0, docHeight - footerBottom);
    }

    const height = Math.floor(window.innerHeight - rowTop - reserved);
    if (height < 240) {
      // not enough room to split, fall back to the scrolling page
      setPanelHeight(rows, null);
      return;
    }

    setPanelHeight(rows, height);
  }

  function galleryColumns(count) {
    if (count <= 1) return 1;
    if (count <= 4) return 2;
    if (count <= 9) return 3;
    return 4;
  }

  function fitGallery(gallery) {
    const grid = gallery.querySelector(".grid-container");
    if (!grid) return;

    const count = grid.querySelectorAll(".thumbnail-lg").length;
    if (count === 0) {
      gallery.style.removeProperty("--generation-gallery-cols");
      gallery.style.removeProperty("--generation-gallery-rows");
      return;
    }

    const columns = galleryColumns(count);
    gallery.style.setProperty("--generation-gallery-cols", `${columns}`);
    gallery.style.setProperty("--generation-gallery-rows", `${Math.ceil(count / columns)}`);
  }

  function observeGalleries() {
    for (const id of GALLERY_IDS) {
      const gallery = gradioApp().getElementById(id);
      if (!gallery) continue;

      const entry = galleryObservers.get(id);
      if (entry && entry.element === gallery) continue;

      if (entry) {
        entry.observer.disconnect();
      }

      const observer = new MutationObserver(() => fitGallery(gallery));
      observer.observe(gallery, { childList: true, subtree: true });
      galleryObservers.set(id, { element: gallery, observer });
      fitGallery(gallery);
    }
  }

  function applyLayout() {
    moveCheckpointIntoParameters();
    fitGenerationRows();
    observeGalleries();
  }

  function scheduleLayout() {
    if (layoutScheduled) return;

    layoutScheduled = true;
    requestAnimationFrame(() => {
      layoutScheduled = false;
      applyLayout();
    });
  }

  window.desktopLayoutUpdate = applyLayout;

  onUiLoaded(applyLayout);
  onAfterUiUpdate(applyLayout);
  onUiTabChange(applyLayout);
  window.addEventListener("resize", scheduleLayout);

  // Inner/main tab switches change which checkpoint host and generation row are
  // visible; Gradio updates the visibility a tick after the click.
  document.addEventListener("click", function () {
    setTimeout(applyLayout, 60);
    setTimeout(applyLayout, 300);
  }, true);
})();
