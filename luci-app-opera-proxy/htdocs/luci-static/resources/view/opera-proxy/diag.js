'use strict';

// Порог в пикселях: насколько близко к низу textarea нужно быть, чтобы
// считать пользователя "внизу" и безопасно дёргать scrollTop при обновлении.
var BOTTOM_THRESHOLD_PX = 40;

var SERVICE_NAME = 'opera-proxy';

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Экранирование аргумента так, чтобы собранную строку можно было скопировать
// и выполнить в оболочке как есть. "Безопасные" аргументы остаются без
// кавычек; всё остальное (пробелы, скобки, '*', ';' и т.п.) берётся в
// одинарные кавычки, а одинарная кавычка внутри превращается в '\''.
function shellQuote(arg) {
    arg = String(arg);
    if (arg !== '' && /^[A-Za-z0-9_\-.,:\/=+@%]+$/.test(arg))
        return arg;
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// Из ответа `ubus call service list '{"name":"..."}'` достаём реальную
// командную строку, с которой procd запустил процесс. Возвращает
// { command: [...], running: bool|undefined } либо null, если у сервиса
// нет ни одного зарегистрированного экземпляра с командой.
function extractServiceCommand(res, name) {
    var svc = res && res[name];
    var instances = svc && svc.instances;
    if (!instances)
        return null;

    var keys = Object.keys(instances);
    for (var i = 0; i < keys.length; i++) {
        var inst = instances[keys[i]];
        if (inst && Array.isArray(inst.command) && inst.command.length)
            return { command: inst.command, running: inst.running };
    }
    return null;
}

return L.Class.extend({
    _form: null,
    _fs: null,
    _poll: null,
    _rpc: null,
    _callServiceList: null,

    _logNode: null,
    _newEntriesBtn: null,
    _pendingText: null,
    _cmdDetails: null,
    _cmdNode: null,
    _pollRegistered: false,

    init: function(deps) {
        this._form = deps.form;
        this._fs   = deps.fs;
        this._poll = deps.poll;
        this._rpc  = deps.rpc;

        // Тот же ответ, что даёт `ubus call service list '{"name":"opera-proxy"}'`:
        // procd отдаёт массив аргументов, с которыми реально запущен процесс.
        this._callServiceList = this._rpc.declare({
            object: 'service',
            method: 'list',
            params: [ 'name' ],
            expect: { '': {} }
        });
    },

    isScrolledToBottom: function() {
        var node = this._logNode;
        if (!node)
            return true;
        return (node.scrollHeight - node.scrollTop - node.clientHeight) < BOTTOM_THRESHOLD_PX;
    },

    applyPending: function() {
        var node = this._logNode;
        if (!node || this._pendingText == null)
            return;

        node.value = this._pendingText;
        node.scrollTop = node.scrollHeight;
        this._pendingText = null;
        this.showNewEntriesBadge(false);
    },

    showNewEntriesBadge: function(show) {
        if (this._newEntriesBtn)
            this._newEntriesBtn.style.display = show ? 'inline-flex' : 'none';
    },

    /**
     * "Умный" tail: если пользователь сейчас внизу лога (или это первая
     * загрузка) — просто подставляем свежий текст и остаёмся внизу. Если он
     * проскроллил вверх читать историю — не дёргаем его: новый текст лежит
     * в _pendingText, а над логом всплывает бейдж "New entries ↓", по клику
     * на который он применяется.
     */
    refreshLogs: function(opts) {
        if (!this._logNode)
            return Promise.resolve();

        var self = this;
        var force = !!(opts && opts.force);
        var wasAtBottom = force || this.isScrolledToBottom();

        return L.resolveDefault(this._fs.exec_direct('/sbin/logread', ['-e', SERVICE_NAME], 'text'), '')
            .then(function(output) {
                var text = String(output || '').trim() || _('No opera-proxy log entries yet');

                if (text === self._logNode.value) {
                    self._pendingText = null;
                    self.showNewEntriesBadge(false);
                    return;
                }

                if (wasAtBottom) {
                    self._logNode.value = text;
                    self._logNode.scrollTop = self._logNode.scrollHeight;
                    self._pendingText = null;
                    self.showNewEntriesBadge(false);
                } else {
                    self._pendingText = text;
                    self.showNewEntriesBadge(true);
                }
            })
            .catch(function(err) {
                if (!self._logNode)
                    return;
                self._logNode.value = (err && err.message) ? err.message : _('Unable to read logs');
            });
    },

    /**
     * Реальная командная строка сервиса — ровно то, что procd передал при
     * запуске (а не то, что мы "вычислили" из UCI и что могло бы разойтись
     * с init.d). Пока у сервиса нет экземпляра в procd (остановлен) —
     * честно пишем, что строки нет. Вывод — через textContent: аргументы
     * могут содержать любые символы, включая '<'.
     */
    refreshCommand: function() {
        if (!this._cmdNode)
            return Promise.resolve();

        var self = this;

        return this._callServiceList(SERVICE_NAME)
            .then(function(res) {
                var info = extractServiceCommand(res, SERVICE_NAME);

                if (!info) {
                    self._cmdNode.textContent = _('Service is not running');
                    return;
                }

                var text = info.command.map(shellQuote).join(' ');
                if (info.running === false)
                    text += '\n\n' + _('Instance is registered but not running');

                self._cmdNode.textContent = text;
            })
            .catch(function(err) {
                self._cmdNode.textContent = (err && err.message) ? err.message : _('Unable to read the service command line');
            });
    },

    register: function(s) {
        var o;
        var form = this._form;

        // Пустой заголовок: при title='' LuCI не создаёт колонки заголовка,
        // а кладёт содержимое в одиночный <output> (растягиваем его в bind()).
        o = s.taboption('diagnostics', form.DummyValue, '_diag', '');
        o.rawhtml = true;
        o.cfgvalue = function() {
            return [
                '<div data-opera-diag="1" style="width:100%">',
                  // position:relative нужен только для бейджа "New entries",
                  // который прижат к нижнему правому углу именно текстареи.
                  '<div style="position:relative">',
                    '<textarea data-opera-logs="1" readonly="readonly" wrap="off" style="',
                      'width:100%;min-height:420px;font-family:monospace;font-size:12px;',
                      'background:#111827;color:#e5e7eb;border:1px solid #374151;',
                      'border-radius:8px;padding:10px">',
                    '</textarea>',
                    '<button type="button" data-opera-new-logs="1" style="',
                      'display:none;position:absolute;right:16px;bottom:16px;',
                      'padding:4px 12px;border-radius:12px;border:none;cursor:pointer;',
                      'font-size:12px;font-weight:600;color:#fff;background:#2563eb;',
                      'box-shadow:0 2px 6px rgba(0,0,0,0.35)">' + escapeHtml(_('New entries')) + ' &darr;</button>',
                  '</div>',
                  // Сворачиваемый блок на нативном <details>: по умолчанию
                  // свёрнут, JS для сворачивания не нужен.
                  '<details data-opera-cmd="1" style="margin-top:12px">',
                    '<summary style="cursor:pointer;user-select:none">' + escapeHtml(_('Service command line')) + '</summary>',
                    '<pre data-opera-cmd-text="1" style="',
                      'margin:8px 0 0;padding:10px;font-family:monospace;font-size:12px;',
                      'white-space:pre-wrap;word-break:break-all;',
                      'background:#111827;color:#e5e7eb;border:1px solid #374151;',
                      'border-radius:8px"></pre>',
                  '</details>',
                '</div>'
            ].join('');
        };
    },

    bind: function(nodes) {
        var self = this;

        this._logNode = nodes.querySelector('[data-opera-logs="1"]');
        this._newEntriesBtn = nodes.querySelector('[data-opera-new-logs="1"]');
        this._cmdDetails = nodes.querySelector('[data-opera-cmd="1"]');
        this._cmdNode = nodes.querySelector('[data-opera-cmd-text="1"]');

        // По DevTools: при title='' в этой теме LuCI не создаёт
        // .cbi-value-title/.cbi-value-field вообще — строка .cbi-value
        // (сама flex-контейнер) содержит один-единственный flex-элемент
        // <output for="...">, который оборачивает наш div. Без явного
        // flex-grow он не растягивается на всю ширину — растягиваем его.
        var wrap = nodes.querySelector('[data-opera-diag="1"]');
        var outputEl = wrap ? wrap.parentElement : null;
        if (outputEl && outputEl.tagName === 'OUTPUT') {
            outputEl.style.setProperty('display', 'block', 'important');
            outputEl.style.setProperty('flex', '1 1 auto', 'important');
            outputEl.style.setProperty('width', '100%', 'important');
            outputEl.style.setProperty('min-width', '0', 'important');
        }

        if (this._newEntriesBtn) {
            this._newEntriesBtn.addEventListener('click', function(ev) {
                ev.preventDefault();
                self.applyPending();
            });
        }

        // Строку запуска запрашиваем только когда блок раскрыт: при открытии
        // и далее на каждом тике опроса. Пока свёрнут — лишних вызовов нет.
        if (this._cmdDetails) {
            this._cmdDetails.addEventListener('toggle', function() {
                if (self._cmdDetails.open)
                    self.refreshCommand();
            });
        }

        this.refreshLogs({ force: true });

        if (!this._pollRegistered) {
            this._poll.add(function() {
                var tasks = [ self.refreshLogs() ];
                if (self._cmdDetails && self._cmdDetails.open)
                    tasks.push(self.refreshCommand());
                return Promise.all(tasks);
            }, 8);
            this._pollRegistered = true;
        }
    }
});
