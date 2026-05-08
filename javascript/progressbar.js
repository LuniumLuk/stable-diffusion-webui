// code related to showing and updating progressbar shown as the image is being made

function rememberGallerySelection() {

}

function getGallerySelectedIndex() {

}

function request(url, data, handler, errorHandler) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
            if (xhr.status === 200) {
                try {
                    var js = JSON.parse(xhr.responseText);
                    handler(js);
                } catch (error) {
                    console.error(error);
                    errorHandler();
                }
            } else {
                errorHandler();
            }
        }
    };
    var js = JSON.stringify(data);
    xhr.send(js);
}

function pad2(x) {
    return x < 10 ? '0' + x : x;
}

function formatTime(secs) {
    if (secs > 3600) {
        return pad2(Math.floor(secs / 60 / 60)) + ":" + pad2(Math.floor(secs / 60) % 60) + ":" + pad2(Math.floor(secs) % 60);
    } else if (secs > 60) {
        return pad2(Math.floor(secs / 60)) + ":" + pad2(Math.floor(secs) % 60);
    } else {
        return Math.floor(secs) + "s";
    }
}


var originalAppTitle = undefined;

// ---------------------------------------------------------------------------
// Global server-status bar — polls /internal/global-status, works for every
// client and survives page refreshes because state lives in the server.
// ---------------------------------------------------------------------------
var globalGpuProgress = {
    root: null,
    fill: null,
    label: null,
    meta: null,
    pollerHandle: null,
};

function requestGet(url, handler, errorHandler) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
            if (xhr.status === 200) {
                try {
                    var js = JSON.parse(xhr.responseText);
                    handler(js);
                } catch (error) {
                    console.error(error);
                    errorHandler();
                }
            } else {
                errorHandler();
            }
        }
    };
    xhr.send();
}

function ensureGlobalGpuProgressBar() {
    if (globalGpuProgress.root && document.body.contains(globalGpuProgress.root)) {
        return;
    }

    var root = document.getElementById('global_gpu_progress');
    if (!root) {
        root = document.createElement('div');
        root.id = 'global_gpu_progress';
        root.className = 'global-gpu-progress';
        root.setAttribute('aria-live', 'polite');
        root.style.display = 'none';

        var fill = document.createElement('div');
        fill.className = 'global-gpu-progress-fill';

        var label = document.createElement('div');
        label.className = 'global-gpu-progress-label';
        label.textContent = '';

        var meta = document.createElement('div');
        meta.id = 'global_gpu_progress_meta';
        meta.className = 'global-gpu-progress-meta';
        meta.textContent = '';

        root.appendChild(fill);
        root.appendChild(label);
        document.body.appendChild(root);
        document.body.appendChild(meta);
    }

    globalGpuProgress.root = root;
    globalGpuProgress.fill = root.querySelector('.global-gpu-progress-fill');
    globalGpuProgress.label = root.querySelector('.global-gpu-progress-label');
    globalGpuProgress.meta = document.getElementById('global_gpu_progress_meta');
}

function renderGlobalStatusResponse(res) {
    ensureGlobalGpuProgressBar();
    if (!res || (!res.active && !res.queued_count)) {
        globalGpuProgress.root.style.display = 'none';
        globalGpuProgress.fill.style.width = '0%';
        globalGpuProgress.fill.textContent = '';
        globalGpuProgress.label.textContent = '';
        if (globalGpuProgress.meta) {
            globalGpuProgress.meta.textContent = '';
            globalGpuProgress.meta.style.display = 'none';
        }
        return;
    }

    var pct = Math.max(0, Math.min(100, (res.progress || 0) * 100.0));
    globalGpuProgress.root.style.display = 'block';
    globalGpuProgress.fill.style.width = pct.toFixed(2) + '%';
    globalGpuProgress.fill.textContent = '';

    // Build label: "Step 14/20  Image 2/4  ETA 8s  |  VRAM 6.2/16.0 GiB (39%)"
    var parts = [];
    if (res.active) {
        if (res.total_steps > 0) {
            parts.push('Step ' + res.step + '/' + res.total_steps);
        }
        if (res.job_count > 1) {
            parts.push('Image ' + (res.job_no + 1) + '/' + res.job_count);
        }
        if (res.textinfo) {
            parts.push(res.textinfo);
        }
        if (res.eta !== null && res.eta !== undefined && res.eta > 0) {
            parts.push('ETA ' + formatTime(res.eta));
        }
    } else if (res.queued_count > 0) {
        parts.push('Queued: ' + res.queued_count);
    }

    if (res.vram_total_gb > 0) {
        var vramPct = Math.round((res.vram_used_gb / res.vram_total_gb) * 100);
        parts.push('VRAM ' + res.vram_used_gb.toFixed(1) + '/' + res.vram_total_gb.toFixed(1) + ' GiB (' + vramPct + '%)');
    }

    globalGpuProgress.label.textContent = parts.join('  |  ');
    if (globalGpuProgress.meta) {
        var finished = Math.max(0, Number(res.finished_images) || 0);
        var total = Math.max(0, Number(res.total_images) || 0);
        var queued = Math.max(0, Number(res.queued_count) || 0);
        globalGpuProgress.meta.textContent = 'Done ' + finished + '  |  Total ' + total + '  |  Queue ' + queued;
        globalGpuProgress.meta.style.display = 'flex';
    }
}

function startGlobalStatusPoller() {
    if (globalGpuProgress.pollerHandle) return;
    ensureGlobalGpuProgressBar();

    function poll() {
        requestGet('./internal/global-status', function(res) {
            renderGlobalStatusResponse(res);
        }, function() {
            // On error keep bar hidden, retry next tick
            renderGlobalStatusResponse(null);
        });
    }

    poll(); // immediate first fetch so bar appears on load if generation is running
    globalGpuProgress.pollerHandle = setInterval(poll, 600);
}

// Legacy stubs — requestProgress still calls these; they are now no-ops because
// the global bar is driven by the server poller, not by per-task callbacks.
function updateGlobalGpuProgress() {}
function clearGlobalGpuProgress() {}

onUiLoaded(function() {
    originalAppTitle = document.title;
    startGlobalStatusPoller();
});

function setTitle(progress) {
    var title = originalAppTitle;

    if (opts.show_progress_in_title && progress) {
        title = '[' + progress.trim() + '] ' + title;
    }

    if (document.title != title) {
        document.title = title;
    }
}


function randomId() {
    return "task(" + Math.random().toString(36).slice(2, 7) + Math.random().toString(36).slice(2, 7) + Math.random().toString(36).slice(2, 7) + ")";
}

// starts sending progress requests to "/internal/progress" uri, creating progressbar above progressbarContainer element and
// preview inside gallery element. Cleans up all created stuff when the task is over and calls atEnd.
// calls onProgress every time there is a progress update
function requestProgress(id_task, progressbarContainer, gallery, atEnd, onProgress, inactivityTimeout = 40) {
    var dateStart = new Date();
    var wasEverActive = false;
    var parentProgressbar = progressbarContainer.parentNode;
    var wakeLock = null;

    var requestWakeLock = async function() {
        if (!opts.prevent_screen_sleep_during_generation || wakeLock) return;
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.error('Wake Lock is not supported.');
        }
    };

    var releaseWakeLock = async function() {
        if (!opts.prevent_screen_sleep_during_generation || !wakeLock) return;
        try {
            await wakeLock.release();
            wakeLock = null;
        } catch (err) {
            console.error('Wake Lock release failed', err);
        }
    };

    var divProgress = document.createElement('div');
    divProgress.className = 'progressDiv';
    divProgress.style.display = opts.show_progressbar ? "block" : "none";
    var divInner = document.createElement('div');
    divInner.className = 'progress';

    divProgress.appendChild(divInner);
    parentProgressbar.insertBefore(divProgress, progressbarContainer);

    var livePreview = null;

    var removeProgressBar = function() {
        releaseWakeLock();
        if (!divProgress) return;

        setTitle("");
        parentProgressbar.removeChild(divProgress);
        if (gallery && livePreview) gallery.removeChild(livePreview);
        clearGlobalGpuProgress(id_task);
        atEnd();

        divProgress = null;
    };

    var funProgress = function(id_task) {
        requestWakeLock();
        request("./internal/progress", {id_task: id_task, live_preview: false}, function(res) {
            updateGlobalGpuProgress(id_task, res);

            if (res.completed) {
                removeProgressBar();
                return;
            }

            let progressText = "";

            divInner.style.width = ((res.progress || 0) * 100.0) + '%';
            divInner.style.background = res.progress ? "" : "transparent";

            if (res.progress > 0) {
                progressText = ((res.progress || 0) * 100.0).toFixed(0) + '%';
            }

            if (res.eta) {
                progressText += " ETA: " + formatTime(res.eta);
            }

            setTitle(progressText);

            if (res.textinfo && res.textinfo.indexOf("\n") == -1) {
                progressText = res.textinfo + " " + progressText;
            }

            divInner.textContent = progressText;

            var elapsedFromStart = (new Date() - dateStart) / 1000;

            if (res.active) wasEverActive = true;

            if (!res.active && wasEverActive) {
                removeProgressBar();
                return;
            }

            if (elapsedFromStart > inactivityTimeout && !res.queued && !res.active) {
                removeProgressBar();
                return;
            }

            if (onProgress) {
                onProgress(res);
            }

            setTimeout(() => {
                funProgress(id_task, res.id_live_preview);
            }, opts.live_preview_refresh_period || 500);
        }, function() {
            clearGlobalGpuProgress(id_task);
            removeProgressBar();
        });
    };

    var funLivePreview = function(id_task, id_live_preview) {
        request("./internal/progress", {id_task: id_task, id_live_preview: id_live_preview}, function(res) {
            if (!divProgress) {
                return;
            }

            if (res.live_preview && gallery) {
                var img = new Image();
                img.onload = function() {
                    if (!livePreview) {
                        livePreview = document.createElement('div');
                        livePreview.className = 'livePreview';
                        gallery.insertBefore(livePreview, gallery.firstElementChild);
                    }

                    livePreview.appendChild(img);
                    if (livePreview.childElementCount > 2) {
                        livePreview.removeChild(livePreview.firstElementChild);
                    }
                };
                img.src = res.live_preview;
            }

            setTimeout(() => {
                funLivePreview(id_task, res.id_live_preview);
            }, opts.live_preview_refresh_period || 500);
        }, function() {
            removeProgressBar();
        });
    };

    funProgress(id_task, 0);

    if (gallery) {
        funLivePreview(id_task, 0);
    }

}
