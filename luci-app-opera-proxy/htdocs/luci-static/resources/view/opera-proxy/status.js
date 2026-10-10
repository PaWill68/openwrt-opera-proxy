'use strict';

// Единая палитра статусов, чтобы не разбрасывать одинаковые hex-цвета
// по badge(), renderStatusHtml() и setActionState(). Если понадобится
// общий модуль на несколько вкладок — этот объект можно вынести туда как есть.
var COLORS = {
    green: '#16a34a', // running / success / HTTP
    red:   '#dc2626', // stopped / error
    blue:  '#2563eb', // SOCKS5
    gray:  '#6b7280'  // service down (нейтральный, независимо от режима)
};

function firstPid(text) {
    var m = String(text || '').trim().match(/^(\d+)/);
    return m ? m[1] : null;
}

function formatKBToMB(kb) {
    var n = parseInt(kb, 10);
    if (isNaN(n) || n < 0)
        return '-';
    return (n / 1024).toFixed(1) + ' ' + _('MB');
}

function formatUptime(sec) {
    if (sec == null || isNaN(sec) || sec < 0)
        return '-';
    sec = Math.round(sec);

    if (sec < 60)
        return _('%ds').format(sec);

    if (sec < 3600) {
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return _('%dm %ds').format(m, s);
    }

    if (sec < 86400) {
        var h = Math.floor(sec / 3600);
        var mm = Math.floor((sec % 3600) / 60);
        return _('%dh %dm').format(h, mm);
    }

    var d = Math.floor(sec / 86400);
    var hh = Math.floor((sec % 86400) / 3600);
    return _('%dd %dh').format(d, hh);
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function badge(label, color, minWidth) {
    return '<span style="display:inline-block;padding:3px 10px;border-radius:10px;' +
        'font-size:12px;font-weight:600;color:#fff;background:' + color + ';' +
        'letter-spacing:0.3px;text-align:center' +
        (minWidth ? ';min-width:' + minWidth + ';' : '') +
        '">' + escapeHtml(label) + '</span>';
}

function statusCard(title, contentHtml) {
    return [
        '<div style="',
            'padding:12px 14px;',
            'border:1px solid rgba(127,127,127,0.25);',
            'border-radius:8px;',
            'background:rgba(127,127,127,0.08)',
        '">',
          '<div style="',
              'font-size:11px;',
              'text-transform:uppercase;',
              'letter-spacing:0.5px;',
              'opacity:0.6;',
              'margin-bottom:8px',
          '">' + escapeHtml(title) + '</div>',
          contentHtml,
        '</div>'
    ].join('');
}

return L.Class.extend({
    _form: null,
    _fs: null,
    _ui: null,
    _uci: null,
    _poll: null,
    _rpc: null,
    _callInitAction: null,

    _statusNode: null,
    _actionNode: null,
    _buttons: {},
    _pollRegistered: false,
    _autostartEnabled: false, // последнее известное состояние rc.d-автозагрузки

    init: function(deps) {
        this._form = deps.form;
        this._fs   = deps.fs;
        this._ui   = deps.ui;
        this._uci  = deps.uci;
        this._poll = deps.poll;
        this._rpc  = deps.rpc;

        this._callInitAction = this._rpc.declare({
            object: 'luci',
            method: 'setInitAction',
            params: [ 'name', 'action' ],
            expect: { result: false }
        });
    },

    readProcValue: function(pid, fieldName) {
        if (!pid)
            return Promise.resolve(null);

        return L.resolveDefault(this._fs.read_direct('/proc/' + pid + '/status'), '').then(function(txt) {
            var m = String(txt || '').match(new RegExp('^' + fieldName + ':\\s+([0-9]+)\\s+kB$', 'm'));
            return m ? m[1] : null;
        });
    },

    /**
     * Свободная память системы в kB. MemAvailable — это правильная метрика,
     * она учитывает кэш, который ядро готово отдать приложению.
     */
    fetchFreeMemory: function() {
        return L.resolveDefault(this._fs.read_direct('/proc/meminfo'), '').then(function(txt) {
            var m = String(txt || '').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
            return m ? m[1] : null;
        });
    },

    /**
     * Uptime процесса в секундах.
     * Берём uptime системы из /proc/uptime, вычитаем время старта процесса
     * из /proc/<pid>/stat (поле 22 — starttime в тиках, обычно HZ=100).
     */
    fetchProcUptime: function(pid) {
        if (!pid)
            return Promise.resolve(null);

        var self = this;
        return Promise.all([
            L.resolveDefault(this._fs.read_direct('/proc/uptime'), ''),
            L.resolveDefault(this._fs.read_direct('/proc/' + pid + '/stat'), '')
        ]).then(function(res) {
            var sysUptime = parseFloat(String(res[0] || '').split(/\s+/)[0]);
            var statTxt = String(res[1] || '');

            if (isNaN(sysUptime))
                return null;

            // Поле 22 в /proc/<pid>/stat — starttime в тиках от загрузки системы.
            // Учитываем, что имя процесса может содержать пробелы в скобках,
            // поэтому берём содержимое после последней ') '.
            var idx = statTxt.lastIndexOf(')');
            if (idx < 0)
                return null;

            var parts = statTxt.substring(idx + 2).split(/\s+/);
            // После ')' идёт поле 3 (state), значит starttime (поле 22) —
            // это parts[22 - 3] = parts[19].
            var startTicks = parseInt(parts[19], 10);

            if (isNaN(startTicks))
                return null;

            // На OpenWrt HZ обычно 100. Используем 100 как стандарт.
            var startSec = startTicks / 100;
            var procUptime = sysUptime - startSec;

            return procUptime > 0 ? procUptime : null;
        });
    },

    /**
     * Единая точка чтения конфигурации прокси из UCI.
     * Используется и в fetchRuntime() (для карточки статуса),
     * и в handleProxyTest() (для теста соединения) — чтобы при
     * изменении логики режима/адреса не пришлось править оба места.
     */
    getProxyConfig: function() {
        var mode = (this._uci.get('opera-proxy', 'main', 'socks_mode') === '1') ? 'SOCKS5' : 'HTTP';
        var bind = this._uci.get('opera-proxy', 'main', 'bind_address') || '127.0.0.1:18080';
        var country = this._uci.get('opera-proxy', 'main', 'country') || 'EU';
        return { mode: mode, bind: bind, country: country };
    },

    /**
     * Включена ли автозагрузка сервиса (rc.d-симлинк). Отдельного UCI-флага
     * 'enabled' больше нет — rc.common сам поддерживает служебный экшен
     * 'enabled', который ничего не делает, а просто возвращает код выхода
     * 0/не-0 (задокументировано в openwrt.org/docs/techref/initscripts).
     * exec_direct() отдаёт только stdout, поэтому здесь нужен exec() —
     * он даёт доступ к .code.
     */
    fetchAutostartEnabled: function() {
        return L.resolveDefault(this._fs.exec('/etc/init.d/opera-proxy', ['enabled']), null)
            .then(function(res) {
                return !!(res && res.code === 0);
            });
    },

    fetchRuntime: function() {
        var self = this;
        var cfg = this.getProxyConfig();

        return L.resolveDefault(this._fs.exec_direct('/bin/pidof', ['opera-proxy'], 'text'), '').then(function(pidText) {
            var pid = firstPid(pidText);

            return Promise.all([
                Promise.resolve(pid),
                self.readProcValue(pid, 'VmRSS'),
                self.fetchFreeMemory(),
                self.fetchProcUptime(pid),
                Promise.resolve(cfg.mode),
                Promise.resolve(cfg.bind),
                Promise.resolve(cfg.country),
                self.fetchAutostartEnabled()
            ]);
        }).then(function(res) {
            return {
                pid:              res[0],
                vmrss:            res[1],
                freeMem:          res[2],
                uptime:           res[3],
                mode:             res[4],
                bind:             res[5],
                country:          res[6],
                autostartEnabled: res[7]
            };
        });
    },

    renderStatusHtml: function(runtime) {
        var running = !!runtime.pid;
        var modeColor = !running ? COLORS.gray : (runtime.mode === 'SOCKS5' ? COLORS.blue : COLORS.green);

        var card1 = statusCard(_('Service state'), [
            '<div><strong>' + escapeHtml(_('PID:')) + '</strong> ' + escapeHtml(runtime.pid || '-') + '</div>',
            '<div style="margin-top:4px"><strong>' + escapeHtml(_('RSS:')) + '</strong> ' + formatKBToMB(runtime.vmrss) + '</div>',
            '<div style="margin-top:10px">' + badge(running ? _('Running') : _('Stopped'), running ? COLORS.green : COLORS.red) + '</div>'
        ].join(''));

        var card2 = statusCard(_('Proxy mode'), [
            '<div><strong>' + escapeHtml(_('Listen:')) + '</strong> ' + escapeHtml(runtime.bind) + '</div>',
            '<div style="margin-top:4px"><strong>' + escapeHtml(_('Country:')) + '</strong> ' + escapeHtml(runtime.country) + '</div>',
            '<div style="margin-top:10px">' + badge(runtime.mode, modeColor, '64px') + '</div>'
        ].join(''));

        var card3 = statusCard(_('Memory'), [
            '<div><strong>' + escapeHtml(_('RSS:')) + '</strong> ' + formatKBToMB(runtime.vmrss) + '</div>',
            '<div style="margin-top:4px"><strong>' + escapeHtml(_('Free:')) + '</strong> ' + formatKBToMB(runtime.freeMem) + '</div>',
            '<div style="margin-top:4px"><strong>' + escapeHtml(_('Uptime:')) + '</strong> ' + formatUptime(runtime.uptime) + '</div>'
        ].join(''));

        return [
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">',
              card1,
              card2,
              card3,
            '</div>'
        ].join('');
    },

    updateButtonsState: function(running) {
        if (this._buttons.start)   this._buttons.start.disabled   = !!running;
        if (this._buttons.stop)    this._buttons.stop.disabled    = !running;
        if (this._buttons.restart) this._buttons.restart.disabled = !running;
        if (this._buttons.test)    this._buttons.test.disabled    = !running;
        // Enable/Disable управляет только автозагрузкой (rc.d) и не зависит
        // от того, запущен ли процесс прямо сейчас — должен оставаться
        // кликабельным всегда (кроме момента выполнения другого действия,
        // см. setActionState).
        if (this._buttons.toggleEnabled) this._buttons.toggleEnabled.disabled = false;
    },

    refreshStatus: function() {
        if (!this._statusNode)
            return Promise.resolve();

        return this.fetchRuntime().then(L.bind(function(runtime) {
            this._statusNode.innerHTML = this.renderStatusHtml(runtime);
            this.updateButtonsState(!!runtime.pid);

            this._autostartEnabled = !!runtime.autostartEnabled;
            if (this._buttons.toggleEnabled) {
                // Подпись показывает ТЕКУЩЕЕ состояние автозагрузки (не действие,
                // которое произойдёт по клику) — клик по-прежнему переключает его.
                this._buttons.toggleEnabled.textContent = this._autostartEnabled ? _('Enabled') : _('Disabled');
                this._buttons.toggleEnabled.style.color = this._autostartEnabled ? '' : COLORS.red;
            }
        }, this)).catch(L.bind(function(err) {
            this._statusNode.innerHTML =
                '<div style="color:#b91c1c"><strong>' + escapeHtml(_('Status read failed:')) + '</strong> ' +
                escapeHtml((err && err.message) ? err.message : _('unknown error')) + '</div>';
        }, this));
    },

    setActionState: function(busy, text, style) {
        if (this._actionNode) {
            this._actionNode.textContent = text || '';
            this._actionNode.style.color =
                style === 'success' ? COLORS.green :
                style === 'error'   ? COLORS.red : '';
        }

        // Блокируем все кнопки, пока действие выполняется. Но когда busy=false,
        // намеренно НЕ трогаем .disabled: раньше это принудительно включало все
        // кнопки разом, затирая то, что updateButtonsState() только что выставил
        // по реальному running-статусу (например, Stop/Test должны оставаться
        // задизейбленными, если сервис на самом деле остановлен). Каждый вызывающий
        // код гарантирует refreshStatus() перед setActionState(false, ...) —
        // именно refreshStatus()/updateButtonsState() решают, что включать.
        if (busy) {
            var btns = this._buttons;
            Object.keys(btns).forEach(function(key) {
                if (btns[key]) btns[key].disabled = true;
            });
        }
    },

    handleServiceAction: function(action) {
        var self = this;
        // Намеренно НЕ используем this._ui.createHandlerFn(): он сам снимает
        // disabled с нажатой кнопки сразу после resolve нашего промиса — поверх
        // того, что только что корректно выставил updateButtonsState() внутри
        // refreshStatus(). При пяти взаимозависимых кнопках это даёт эффект
        // "кнопка включилась-выключилась". Управляем disabled полностью сами.
        return function(ev) {
            if (ev) ev.preventDefault();

            // В сообщениях показываем переведённую подпись кнопки, а не
            // служебное имя действия ("start"/"stop"/"restart").
            var label = ({ start: _('Start'), stop: _('Stop'), restart: _('Restart') })[action] || action;

            self.setActionState(true, _('Executing action: %s ...').format(label));

            return self._callInitAction('opera-proxy', action)
                .then(function() {
                    return new Promise(function(r) { window.setTimeout(r, 1500); });
                })
                .then(function() { return self.refreshStatus(); })
                .then(function() {
                    self.setActionState(false, _('Last action completed: %s').format(label), 'success');
                })
                .catch(function(err) {
                    var msg = (err && err.message) ? err.message : _('Operation failed');
                    return self.refreshStatus().then(function() {
                        self.setActionState(false, msg, 'error');
                    });
                });
        };
    },

    handleProxyTest: function() {
        var self = this;
        return function(ev) {
            var cfg = self.getProxyConfig();
            var mode = cfg.mode;
            var bind = cfg.bind;
            var args;

            if (ev) ev.preventDefault();

            if (mode === 'SOCKS5')
                args = ['--silent', '--show-error', '--max-time', '15', '--socks5-hostname', bind, 'http://ipv4.icanhazip.com'];
            else
                args = ['--silent', '--show-error', '--max-time', '15', '--proxy', 'http://' + bind, 'http://ipv4.icanhazip.com'];

            self.setActionState(true, _('Testing proxy via %s %s ...').format(mode, bind));

            return L.resolveDefault(self._fs.exec_direct('/usr/bin/curl', args, 'text'), '')
                .then(function(output) {
                    var ip = String(output || '').trim();
                    if (!ip) throw new Error(_('Empty response from test target'));
                    return self.refreshStatus().then(function() {
                        self.setActionState(false, _('Proxy test succeeded. Exit IP: %s').format(ip), 'success');
                    });
                })
                .catch(function(err) {
                    var msg = (err && err.message) ? err.message : _('Proxy test failed');
                    return self.refreshStatus().then(function() {
                        self.setActionState(false, msg, 'error');
                    });
                });
        };
    },

    /**
     * Включает/выключает автозагрузку сервиса — вызывает стандартные
     * rc.common-действия 'enable'/'disable' тем же RPC, что уже используется
     * для start/stop/restart (_callInitAction). Отдельного UCI-флага больше
     * нет: rc.d-симлинк — единственный источник истины. Это не трогает уже
     * запущенный процесс — только решает, что произойдёт при следующей
     * загрузке роутера.
     */
    handleToggleEnabled: function() {
        var self = this;
        return function(ev) {
            if (ev) ev.preventDefault();

            var isEnabled = self._autostartEnabled;
            var rcAction = isEnabled ? 'disable' : 'enable';

            self.setActionState(true, isEnabled ? _('Disabling autostart ...') : _('Enabling autostart ...'));

            return self._callInitAction('opera-proxy', rcAction)
                .then(function() {
                    return self.refreshStatus();
                })
                .then(function() {
                    self.setActionState(false, isEnabled ? _('Autostart disabled.') : _('Autostart enabled.'), 'success');
                })
                .catch(function(err) {
                    var msg = (err && err.message) ? err.message : _('Operation failed');
                    return self.refreshStatus().then(function() {
                        self.setActionState(false, msg, 'error');
                    });
                });
        };
    },

    register: function(s) {
        var o;
        var form = this._form;

        o = s.taboption('status', form.DummyValue, '_status', _('Runtime state'));
        o.rawhtml = true;
        o.cfgvalue = function() {
            return [
                // Тема LuCI резервирует под .cbi-value-title фиксированную (обычно
                // широкую) колонку с выравниванием текста по правому краю. Для
                // коротких подписей ("Runtime state", "Actions") это оставляет
                // пустое место слева. Сужаем колонку до ширины текста, чтобы
                // содержимое строки (карточки/кнопки) подтянулось влево.
                '<style>',
                  '.cbi-value:has([data-opera-proxy-status]) > .cbi-value-title,',
                  '.cbi-value:has([data-opera-actions-container]) > .cbi-value-title {',
                    'width:auto;',
                    'min-width:0;',
                    'flex:0 0 auto;',
                    'white-space:nowrap;',
                    'text-align:left;',
                    'padding-right:12px;',
                  '}',
                '</style>',
                '<div data-opera-proxy-status="1" style="color:inherit">' + escapeHtml(_('Loading status...')) + '</div>'
            ].join('');
        };

        o = s.taboption('status', form.DummyValue, '_actions', _('Actions'));
        o.rawhtml = true;
        o.cfgvalue = function() {
            function actionRow(label, action, buttonText, buttonClass) {
                return [
                    '<div class="cbi-value">',
                      '<label class="cbi-value-title">' + escapeHtml(label) + '</label>',
                      '<div class="cbi-value-field">',
                        '<button type="button" class="btn cbi-button ' + (buttonClass || 'cbi-button-action') + '"',
                          ' data-opera-action="' + action + '"',
                          ' style="min-width:160px">' + escapeHtml(buttonText) + '</button>',
                      '</div>',
                    '</div>'
                ].join('');
            }

            // Реальное состояние автозагрузки узнаём асинхронно (нужен код
            // выхода "/etc/init.d/opera-proxy enabled", а cfgvalue() должен
            // вернуть HTML синхронно). До первого refreshStatus() (он
            // вызывается сразу в bind()) подпись нейтральная.
            return [
                '<div data-opera-actions-container="1">',
                  actionRow(_('Start service'),            'start',          _('Start')),
                  actionRow(_('Restart service'),          'restart',        _('Restart')),
                  actionRow(_('Stop service'),             'stop',           _('Stop'),      'cbi-button-remove'),
                  actionRow(_('Enable service'),           'toggle_enabled', '...'),
                  actionRow(_('Test proxy connection'),    'test',           _('Test proxy'),'cbi-button-action important'),
                '</div>',
                '<div class="cbi-value">',
                  '<label class="cbi-value-title"></label>',
                  '<div class="cbi-value-field">',
                    '<div data-opera-action-state="1" style="min-height:1.4em">' + escapeHtml(_('No action executed yet')) + '</div>',
                  '</div>',
                '</div>'
            ].join('');
        };
    },

    bind: function(nodes) {
        var self = this;

        this._statusNode = nodes.querySelector('[data-opera-proxy-status="1"]');
        this._actionNode = nodes.querySelector('[data-opera-action-state="1"]');

        this._buttons = {
            start:         nodes.querySelector('[data-opera-action="start"]'),
            stop:          nodes.querySelector('[data-opera-action="stop"]'),
            restart:       nodes.querySelector('[data-opera-action="restart"]'),
            toggleEnabled: nodes.querySelector('[data-opera-action="toggle_enabled"]'),
            test:          nodes.querySelector('[data-opera-action="test"]')
        };

        if (this._buttons.start)         this._buttons.start.addEventListener('click',         this.handleServiceAction('start'));
        if (this._buttons.stop)          this._buttons.stop.addEventListener('click',           this.handleServiceAction('stop'));
        if (this._buttons.restart)       this._buttons.restart.addEventListener('click',        this.handleServiceAction('restart'));
        if (this._buttons.toggleEnabled) this._buttons.toggleEnabled.addEventListener('click',   this.handleToggleEnabled());
        if (this._buttons.test)          this._buttons.test.addEventListener('click',            this.handleProxyTest());

        this.refreshStatus();

        if (!this._pollRegistered) {
            this._poll.add(function() { return self.refreshStatus(); }, 8);
            this._pollRegistered = true;
        }
    }
});
