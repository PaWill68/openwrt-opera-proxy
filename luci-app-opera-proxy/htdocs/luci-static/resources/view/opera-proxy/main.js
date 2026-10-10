'use strict';
'require view';
'require form';
'require rpc';
'require poll';
'require ui';
'require uci';
'require fs';
'require view.opera-proxy.status';
'require view.opera-proxy.settings';
'require view.opera-proxy.diag';

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Первая непустая строка вывода "opera-proxy -version". Берём stdout, а если
// он пуст — stderr (Go-программы иногда печатают версию именно туда).
function parseVersion(res) {
    var text = res ? String(res.stdout || res.stderr || '') : '';
    var lines = text.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
    return lines.length ? lines[0] : '';
}

return view.extend({
    _status: null,
    _settings: null,
    _diag: null,
    _deps: null,
    _version: '',

    load: function() {
        var self = this;

        this._deps = {
            form: form,
            fs:   fs,
            ui:   ui,
            uci:  uci,
            poll: poll,
            rpc:  rpc
        };

        return Promise.all([
            uci.load('opera-proxy'),
            L.require('view.opera-proxy.status'),
            L.require('view.opera-proxy.settings'),
            L.require('view.opera-proxy.diag'),
            L.resolveDefault(fs.exec('/usr/bin/opera-proxy', ['-version']), null)
        ]).then(function(mods) {
            self._status   = mods[1];
            self._settings = mods[2];
            self._diag     = mods[3];
            self._version  = parseVersion(mods[4]);

            self._status.init(self._deps);
            self._settings.init(self._deps);
            self._diag.init(self._deps);
        });
    },

    render: function() {
        var m, s;

        // Версия бинарника — мелким приглушённым текстом справа от заголовка.
        // Заголовок form.Map рендерится как HTML, поэтому span работает;
        // сама версия экранируется, т.к. это вывод внешней программы.
        var title = _('Opera Proxy');
        if (this._version)
            title += ' <span style="font-size:14px;font-weight:normal;opacity:0.6;margin-left:6px">' +
                escapeHtml(this._version) + '</span>';

        m = new form.Map('opera-proxy', title,
            _('Opera Proxy for OpenWrt with LuCI control panel, runtime status, colored mode badge and built-in upstream proxy test.'));

        s = m.section(form.NamedSection, 'main', 'service');
        s.anonymous = true;
        s.addremove = false;

        s.tab('status',      _('Status'));
        s.tab('settings',    _('Settings'));
        s.tab('diagnostics', _('Diagnostics'));

        this._status.register(s);
        this._settings.register(s);
        this._diag.register(s);

        return m.render().then(L.bind(function(nodes) {
            this._status.bind(nodes);
            this._diag.bind(nodes);
            return nodes;
        }, this));
    },

    handleSaveApply: function(ev, mode) {
        var self = this;

        return this.super('handleSaveApply', [ev, mode]).then(function(res) {
            return uci.load('opera-proxy').then(function() {
                return self._status.refreshStatus().then(function() { return res; });
            });
        });
    }
});
