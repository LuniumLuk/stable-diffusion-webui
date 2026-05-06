(function () {
    var host = null;
    var activeTimers = {};

    function ensureHost() {
        if (host && document.body.contains(host)) {
            return host;
        }

        host = document.createElement('div');
        host.id = 'global_banner_host';
        document.body.appendChild(host);
        return host;
    }

    function removeBanner(key) {
        var appHost = ensureHost();
        var banner = appHost.querySelector('[data-banner-key="' + key + '"]');
        if (!banner) {
            return;
        }

        banner.classList.remove('show');
        banner.classList.add('hide');
        window.setTimeout(function () {
            if (banner.parentNode) {
                banner.parentNode.removeChild(banner);
            }
        }, 220);
    }

    function showBanner(message, options) {
        var opts = options || {};
        var key = opts.key || ('banner-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
        var kind = opts.kind || 'info';
        var duration = typeof opts.duration === 'number' ? opts.duration : 3200;
        var appHost = ensureHost();

        if (activeTimers[key]) {
            window.clearTimeout(activeTimers[key]);
            delete activeTimers[key];
            removeBanner(key);
        }

        var banner = document.createElement('div');
        banner.className = 'global-banner global-banner-' + kind;
        banner.setAttribute('data-banner-key', key);
        banner.textContent = String(message || '');
        appHost.appendChild(banner);

        window.requestAnimationFrame(function () {
            banner.classList.add('show');
        });

        if (duration > 0) {
            activeTimers[key] = window.setTimeout(function () {
                delete activeTimers[key];
                removeBanner(key);
            }, duration);
        }

        return key;
    }

    window.webuiBanner = {
        show: showBanner,
        hide: removeBanner,
    };
})();