function queue_job_txt2img() {
    return Array.from(arguments);
}

function queue_job_img2img() {
    var res = Array.from(arguments);
    res[1] = get_tab_index('mode_img2img');
    return res;
}

(function () {
    var monitorTimer = null;
    var activeProgressTrackers = {};
    var queueControlsForcedVisible = false;
    var lastQueueActivityAt = 0;
    var QUEUE_TRACKER_STATE_KEY = 'webui_queue_active_task';

    function saveQueueTrackerState(taskId, jobType, imageCount) {
        if (!taskId || !jobType) return;
        try {
            localSet(QUEUE_TRACKER_STATE_KEY, JSON.stringify({
                taskId: String(taskId),
                jobType: jobType === 'img2img' ? 'img2img' : 'txt2img',
                imageCount: Math.max(1, Number(imageCount) || 1),
                ts: Date.now(),
            }));
        } catch (_e) {
            // no-op
        }
    }

    function loadQueueTrackerState() {
        try {
            var raw = localGet(QUEUE_TRACKER_STATE_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || !parsed.taskId || !parsed.jobType) return null;
            return {
                taskId: String(parsed.taskId),
                jobType: parsed.jobType === 'img2img' ? 'img2img' : 'txt2img',
                imageCount: Math.max(1, Number(parsed.imageCount) || 1),
            };
        } catch (_e) {
            return null;
        }
    }

    function clearQueueTrackerState(taskId) {
        try {
            var raw = localGet(QUEUE_TRACKER_STATE_KEY);
            if (!raw) return;
            var parsed = JSON.parse(raw);
            if (taskId && parsed && parsed.taskId && String(parsed.taskId) !== String(taskId)) {
                return;
            }
            localRemove(QUEUE_TRACKER_STATE_KEY);
        } catch (_e) {
            localRemove(QUEUE_TRACKER_STATE_KEY);
        }
    }

    function isQueueTabVisible() {
        var queueTab = gradioApp().getElementById('tab_job_queue_tab');
        return Boolean(queueTab && queueTab.style.display !== 'none');
    }

    function markQueueActivity() {
        lastQueueActivityAt = Date.now();
    }

    function setGenerateButtonsDisabled(disabled) {
        var txt2imgGenerate = gradioApp().getElementById('txt2img_generate');
        var img2imgGenerate = gradioApp().getElementById('img2img_generate');

        if (txt2imgGenerate) txt2imgGenerate.disabled = disabled;
        if (img2imgGenerate) img2imgGenerate.disabled = disabled;
    }

    function setInterruptSkipForAllTabs(running) {
        var showNormalButtons = !running;

        if (typeof setAllGenerationButtonsVisibility === 'function') {
            setAllGenerationButtonsVisibility(showNormalButtons);
            return;
        }

        showSubmitButtons('txt2img', showNormalButtons);
        showSubmitButtons('img2img', showNormalButtons);
    }

    function hasActiveQueueTracker() {
        return Object.keys(activeProgressTrackers).length > 0;
    }

    function getRunningQueueTask() {
        var host = gradioApp().getElementById('jq-state');
        if (!host) {
            return null;
        }

        var taskId = host.getAttribute('data-running-task-id') || '';
        var jobType = host.getAttribute('data-running-job-type') || '';
        var imageCount = Number(host.getAttribute('data-running-image-count') || '0');

        if (!taskId || !jobType) {
            return null;
        }

        return {
            taskId: taskId,
            jobType: jobType,
            imageCount: Math.max(1, imageCount || 1),
        };
    }

    function startQueueProgressTracking(taskId, jobType) {
        if (!taskId || activeProgressTrackers[taskId]) {
            return;
        }

        var tabName = jobType === 'img2img' ? 'img2img' : 'txt2img';
        var container = gradioApp().getElementById(tabName + '_gallery_container');
        var gallery = gradioApp().getElementById(tabName + '_gallery');
        if (!container || !gallery) {
            return;
        }

        var imageCount = arguments.length > 2 ? arguments[2] : 1;
        activeProgressTrackers[taskId] = {
            jobType: jobType,
            imageCount: Math.max(1, Number(imageCount) || 1),
            startedNotified: false,
        };
        saveQueueTrackerState(taskId, jobType, imageCount);
        lastQueueActivityAt = Date.now();

        if (typeof notifyGenerationEvent === 'function') {
            notifyGenerationEvent(jobType, imageCount, 'start', 'queue');
            activeProgressTrackers[taskId].startedNotified = true;
        }

        requestProgress(taskId, container, gallery, function () {
            var trackerMeta = activeProgressTrackers[taskId] || { jobType: jobType, imageCount: imageCount };
            delete activeProgressTrackers[taskId];
            clearQueueTrackerState(taskId);
            lastQueueActivityAt = Date.now();

            localSet(tabName + '_task_id', taskId);
            var restoreButton = gradioApp().getElementById(tabName + '_restore_progress');
            if (restoreButton) {
                restoreButton.click();
            }

            if (typeof notifyGenerationEvent === 'function') {
                notifyGenerationEvent(trackerMeta.jobType, trackerMeta.imageCount, 'finish', 'queue');
            }
        }, null, 0);
    }

    function restoreQueueProgressOnLoad() {
        var persisted = loadQueueTrackerState();
        if (!persisted || !persisted.taskId) {
            return;
        }

        setGenerateButtonsDisabled(true);
        setInterruptSkipForAllTabs(true);
        queueControlsForcedVisible = true;
        markQueueActivity();
        startQueueProgressTracking(persisted.taskId, persisted.jobType, persisted.imageCount);
    }

    function refreshQueueAndSyncUi() {
        var refreshButton = gradioApp().getElementById('jq_refresh_btn');
        var shouldRefreshQueue = isQueueTabVisible() || hasActiveQueueTracker() || (Date.now() - lastQueueActivityAt) < 5000;
        if (refreshButton && shouldRefreshQueue) {
            refreshButton.click();
        }

        setTimeout(function () {
            var runningTask = getRunningQueueTask();
            var queueActive = Boolean(runningTask) || hasActiveQueueTracker();

            if (runningTask) {
                lastQueueActivityAt = Date.now();
            }

            // Prevent short-lived state flaps from showing the Generate button.
            if (!queueActive && (Date.now() - lastQueueActivityAt) < 2500) {
                queueActive = true;
            }

            setGenerateButtonsDisabled(queueActive);

            if (queueActive) {
                // Re-apply every cycle so other callbacks cannot revert controls
                // while a queued task is still active (e.g. on chained queue jobs).
                setInterruptSkipForAllTabs(true);
                queueControlsForcedVisible = true;
                if (runningTask) {
                    startQueueProgressTracking(runningTask.taskId, runningTask.jobType, runningTask.imageCount);
                }
            } else if (queueControlsForcedVisible) {
                setInterruptSkipForAllTabs(false);
                queueControlsForcedVisible = false;
            }
        }, 120);
    }

    function startMonitor() {
        if (monitorTimer) {
            return;
        }

        // Force a short initial sync window after page reload so running queue jobs
        // can be rediscovered even when Queue tab is not currently visible.
        markQueueActivity();

        var txt2imgQueueBtn = gradioApp().getElementById('txt2img_queue_btn');
        var img2imgQueueBtn = gradioApp().getElementById('img2img_queue_btn');
        if (txt2imgQueueBtn && !txt2imgQueueBtn.dataset.jqActivityBound) {
            txt2imgQueueBtn.addEventListener('click', markQueueActivity);
            txt2imgQueueBtn.dataset.jqActivityBound = '1';
        }
        if (img2imgQueueBtn && !img2imgQueueBtn.dataset.jqActivityBound) {
            img2imgQueueBtn.addEventListener('click', markQueueActivity);
            img2imgQueueBtn.dataset.jqActivityBound = '1';
        }

        monitorTimer = setInterval(function () {
            refreshQueueAndSyncUi();
        }, 1500);
    }

    onUiLoaded(function () {
        startMonitor();
        restoreQueueProgressOnLoad();
    });
})();
