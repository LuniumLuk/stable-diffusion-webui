(function () {
    function setTextboxValue(elemId, value) {
        var el = gradioApp().querySelector('#' + elemId + ' textarea');
        if (!el) return false;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    window.queueTabAction = function (action, jobId) {
        var payload = JSON.stringify({ action: action, job_id: jobId || '' });
        if (!setTextboxValue('jq_action_input', payload)) {
            return;
        }

        var btn = gradioApp().getElementById('jq_action_btn');
        if (btn) {
            btn.click();
        }
    };
})();