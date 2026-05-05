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

        if (!taskId || !jobType) {
            return null;
        }

        return {
            taskId: taskId,
            jobType: jobType,
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

        activeProgressTrackers[taskId] = true;
        lastQueueActivityAt = Date.now();

        requestProgress(taskId, container, gallery, function () {
            delete activeProgressTrackers[taskId];
            lastQueueActivityAt = Date.now();

            localSet(tabName + '_task_id', taskId);
            var restoreButton = gradioApp().getElementById(tabName + '_restore_progress');
            if (restoreButton) {
                restoreButton.click();
            }
        }, null, 0);
    }

    function refreshQueueAndSyncUi() {
        var refreshButton = gradioApp().getElementById('jq_refresh_btn');
        if (refreshButton) {
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
                    startQueueProgressTracking(runningTask.taskId, runningTask.jobType);
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

        monitorTimer = setInterval(function () {
            refreshQueueAndSyncUi();
        }, 1500);
    }

    onUiLoaded(function () {
        startMonitor();
    });
})();
