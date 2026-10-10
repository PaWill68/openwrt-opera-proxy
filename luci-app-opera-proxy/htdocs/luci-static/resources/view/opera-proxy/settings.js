'use strict';

// ВАЖНО для регулярок в этом файле: luci.mk при сборке пакета прогоняет JS через
// jsmin, а он распознаёт литерал регулярки только после ( , = : [ ! & | ? + - ~ * / { } ;
// но НЕ после слова return. Регулярка с кавычкой после "return /.../" принимается за
// начало строки и портит код (или случайно работает, если кавычки встретились парой).
// Поэтому после return регулярка всегда берётся в скобки: return (/.../).test(x).
// Проверяется скриптом scripts/lint-js.sh.

// Бинарник разбирает эти поля как time.Duration из Go: число с обязательной
// единицей (ns, us, ms, s, m, h), можно составное ("1m30s", "4h0m0s",
// "1.5s"). Голое "30" он отвергает и падает при старте — отсюда crash loop
// в procd. Поэтому проверяем формат прямо в форме. Пустое значение допустимо
// (бинарник возьмёт своё по умолчанию), "0" Go тоже принимает.
var DURATION_RE = /^(0|(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|\u00b5s|\u03bcs|ms|s|m|h))+)$/;

function validateDuration(section_id, value) {
    if (value === '' || value == null || DURATION_RE.test(value))
        return true;
    return _('Expecting a duration with a unit, e.g. 30s, 1m30s or 4h');
}

// ----- Остальные проверки сверены с main.go (parse_args()/run()) бинарника ---
// Везде: пустое значение допустимо (бинарник возьмёт своё по умолчанию).
// Сообщения вызывают _() внутри функций, а не при загрузке модуля, чтобы
// перевод применялся уже после загрузки языка.

// discover-repeat и api-proxy-parallel: бинарник завершается с arg_fail
// при значении < 1, поэтому "0" (который проходит uinteger) недопустим.
function validatePositiveInt(section_id, value) {
    if (value === '' || value == null || /^[1-9]\d*$/.test(value))
        return true;
    return _('Expecting an integer greater than 0');
}

// URL списка прокси и тестовый URL скачивания — только http(s) с хостом.
var HTTP_URL_RE = /^https?:\/\/[^\s\/?#]+(?:[\/?#]\S*)?$/;

function validateHttpUrl(section_id, value) {
    if (value === '' || value == null || HTTP_URL_RE.test(value))
        return true;
    return _('Expecting a URL starting with http:// or https://');
}

// Хост: IPv4 (каждый октет 0-255), IPv6 в квадратных скобках или имя хоста.
// Строка из одних цифр и точек обязана быть корректным IPv4 — иначе "127.0.0"
// прошло бы как "имя хоста".
function isValidHost(host) {
    if (host.charAt(0) === '[')
        return (/^\[[0-9A-Fa-f:.]+\]$/).test(host);

    if (/^[0-9.]+$/.test(host)) {
        var p = host.split('.');
        return p.length === 4 && p.every(function(x) {
            return (/^\d{1,3}$/).test(x) && +x <= 255;
        });
    }

    return host.length <= 253 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(host);
}

function isValidPort(port) {
    return (/^\d{1,5}$/).test(port) && +port >= 1 && +port <= 65535;
}

// proxy / api-proxy: бинарник разбирает значение через url.Parse и
// xproxy.FromURL — без схемы или с чужой схемой он завершается (код 6/7).
// Саму схему проверяет регулярка, а хост и порт — отдельно: url.Parse из Go
// пропускает даже "http://127,0,0,1:123" (запятые допустимы в имени), и
// такой прокси потом просто не резолвится.
function isValidProxyUrl(v) {
    var m = /^(?:https?|socks5h?):\/\/([^\/?#\s]+)(?:[\/?#]\S*)?$/.exec(v);
    if (!m)
        return false;

    var authority = m[1];
    var at = authority.lastIndexOf('@');
    var hostport = at >= 0 ? authority.slice(at + 1) : authority;
    var host, port = null;

    if (hostport.charAt(0) === '[') {
        var end = hostport.indexOf(']');
        if (end < 0)
            return false;
        host = hostport.slice(0, end + 1);
        var rest = hostport.slice(end + 1);
        if (rest !== '') {
            if (rest.charAt(0) !== ':')
                return false;
            port = rest.slice(1);
        }
    } else {
        var parts = hostport.split(':');
        if (parts.length > 2)
            return false;
        host = parts[0];
        if (parts.length === 2)
            port = parts[1];
    }

    return isValidHost(host) && (port === null || isValidPort(port));
}

function validateProxyUrl(section_id, value) {
    if (value === '' || value == null || isValidProxyUrl(value))
        return true;
    return _('Expecting scheme://[login:password@]host[:port], where scheme is http, https, socks5 or socks5h');
}

// Fake SNI — это доменное имя вида example.com. Встроенный тип LuCI
// "hostname" пропускает и одиночную метку без точки ("12345f"), что для SNI
// бессмысленно, поэтому проверяем сами: минимум две метки, TLD из букв
// (или punycode xn--), IP-адреса не подходят.
function validateDomainName(section_id, value) {
    if (value === '' || value == null)
        return true;

    var ok = value.length <= 253 &&
        /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/.test(value);

    return ok ? true : _('Expecting a domain name, e.g. example.com');
}

// Списки (DynamicList) init.d склеивает в одну строку через запятую, поэтому
// запятая, пробел или кавычка внутри элемента ломают разбор. Валидатор
// принимает и одно значение, и массив — на случай разных версий LuCI.
function eachItem(value, check) {
    var items = Array.isArray(value) ? value : [ value ];
    for (var i = 0; i < items.length; i++) {
        var v = items[i];
        if (v === '' || v == null)
            continue;
        if (!check(String(v)))
            return false;
    }
    return true;
}

// bootstrap-dns: поддерживаются только схемы dns://, https://, tls://, tcp://
// (иначе резолвер не создаётся и бинарник завершается с кодом 4).
function validateBootstrapDns(section_id, value) {
    var ok = eachItem(value, function(v) {
        return (/^(?:dns|https|tls|tcp):\/\/[^\s,"]+$/).test(v);
    });
    return ok ? true : _('Each entry must start with dns://, https://, tls:// or tcp:// and contain no spaces or commas');
}

function validateBypassPattern(section_id, value) {
    var ok = eachItem(value, function(v) {
        return (/^[^\s,"]+$/).test(v);
    });
    return ok ? true : _('Each pattern must not contain spaces, commas or quotes');
}

return L.Class.extend({
    _form: null,

    init: function(deps) {
        this._form = deps.form;
    },

    register: function(s) {
        var form = this._form;
        var o, ss;

        // Настоящие вложенные вкладки в LuCI CBI: form.SectionValue оборачивает
        // ТУ ЖЕ самую uci-секцию ('main'/'service') ещё раз как NamedSection.
        // У вложенной секции (ss) уже собственный набор .tab()/.taboption().
        o = s.taboption('settings', form.SectionValue, '_subsection',
            form.NamedSection, 'main', 'service');
        ss = o.subsection;

        ss.tab('general', _('General'));
        ss.tab('api',     _('API'));
        ss.tab('proxy',   _('Proxy'));
        ss.tab('server',  _('Server'));

        // Принцип: ни один параметр не обязателен. Пустое поле = опция не
        // пишется в UCI, init.d не передаёт флаг, и бинарник сам использует
        // своё значение по умолчанию. Поэтому нигде нет o.default — значения
        // по умолчанию показываются только в placeholder и в описании.
        // Для выпадающих списков "не задано" — явный пункт "Default (...)".
        //
        // Все строки для пользователя обёрнуты в _() — под будущую локализацию.
        // Внутрь _() всегда один литерал целиком (без конкатенации), иначе
        // сканер строк для .po-файла его не увидит; многострочные описания
        // собираются из отдельных _() через '<br>'.

        // ===================== General =====================

        o = ss.taboption('general', form.ListValue, 'socks_mode', _('Proxy mode'));
        o.value('', _('HTTP'));
        o.value('1', _('SOCKS5'));
        o.optional = true;
        o.rmempty = true;
        o.description = _('Proxy server mode (default "HTTP")');

        o = ss.taboption('general', form.Value, 'bind_address', _('Listen address'));
        o.datatype = 'hostport';
        o.placeholder = '127.0.0.1:18080';
        o.rmempty = true;
        o.description = _('Proxy listen address (default "127.0.0.1:18080")');

        o = ss.taboption('general', form.ListValue, 'country', _('Country'));
        o.value('EU', _('EU - Europe'));
        o.value('AM', _('AM - Americas'));
        o.value('AS', _('AS - Asia'));
        o.optional = true;
        o.rmempty = true;
        o.description = _('Desired proxy location (default "EU")');

        o = ss.taboption('general', form.DynamicList, 'bootstrap_dns', _('Bootstrap DNS'));
        o.validate = validateBootstrapDns;
        o.rmempty = true;
        o.description = _('List of DNS/DoH/DoT resolvers for initial discovery of SurfEasy API address') + '<br>' +
            _('Supported schemes are: dns://, https://, tls://, tcp://') + '<br>' +
            _('Examples: https://1.1.1.1/dns-query, tls://9.9.9.9:853') + '<br>' +
            _('Leave empty to use the built-in list:') + ' https://1.1.1.3/dns-query, https://8.8.8.8/dns-query, https://dns.google/dns-query, ...';

        o = ss.taboption('general', form.Value, 'cafile', _('CA file'));
        o.datatype = 'string';
        o.placeholder = '/etc/ssl/certs/ca-certificates.crt';
        o.rmempty = true;
        o.description = _('Use custom CA certificate bundle file');

        o = ss.taboption('general', form.Value, 'fake_sni', _('Fake SNI'));
        o.datatype = 'string';
        o.validate = validateDomainName;
        o.rmempty = true;
        o.description = _('Domain name to use as SNI in outbound TLS and tunneled TLS ClientHello where possible');

        o = ss.taboption('general', form.Value, 'init_retries', _('Init retries'));
        o.datatype = 'uinteger';
        o.placeholder = '0';
        o.rmempty = true;
        o.description = _('Number of attempts for initialization steps (0 = unlimited)');

        o = ss.taboption('general', form.Value, 'init_retry_interval', _('Init retry interval'));
        o.datatype = 'string';
        o.validate = validateDuration;
        o.placeholder = '5s';
        o.rmempty = true;
        o.description = _('Delay between initialization retries (default 5s)');

        o = ss.taboption('general', form.Value, 'discover_repeat', _('Discover repeat'));
        o.validate = validatePositiveInt;
        o.datatype = 'uinteger';
        o.placeholder = '1';
        o.rmempty = true;
        o.description = _('Number of repeated discover requests to aggregate and deduplicate (default 1)');

        o = ss.taboption('general', form.ListValue, 'verbosity', _('Verbosity'));
        o.value('10', _('10 - debug'));
        o.value('20', _('20 - info'));
        o.value('30', _('30 - warning'));
        o.value('40', _('40 - error'));
        o.value('50', _('50 - critical'));
        o.value('60', _('60 - silent (no output)'));
        o.optional = true;
        o.rmempty = true;
        o.description = _('Logging verbosity (default 20 - info)');

        // ===================== API =====================

        o = ss.taboption('api', form.Value, 'api_address', _('API address override'));
        o.datatype = 'string';
        o.rmempty = true;
        o.description = _('Override IP address of api2.sec-tunnel.com');

        o = ss.taboption('api', form.Value, 'api_client_type', _('API client type'));
        o.datatype = 'string';
        o.placeholder = 'se0316';
        o.rmempty = true;
        o.description = _('Client type reported to SurfEasy API (default "se0316")');

        o = ss.taboption('api', form.Value, 'api_client_version', _('API client version'));
        o.datatype = 'string';
        o.placeholder = 'Stable 114.0.5282.21';
        o.rmempty = true;
        o.description = _('Client version reported to SurfEasy API (default "Stable 114.0.5282.21")');

        o = ss.taboption('api', form.Value, 'api_login', _('API login'));
        o.datatype = 'string';
        o.placeholder = 'se0316';
        o.rmempty = true;
        o.description = _('SurfEasy API login (default "se0316")');

        o = ss.taboption('api', form.Value, 'api_password', _('API password'));
        o.datatype = 'string';
        o.placeholder = 'SILrMEPBmJuhomxWkfm3JalqHX2Eheg1YhlEZiMh8II';
        o.rmempty = true;
        o.description = _('SurfEasy API password (default "SILrMEPBmJuhomxWkfm3JalqHX2Eheg1YhlEZiMh8II")');

        var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0';
        o = ss.taboption('api', form.Value, 'api_user_agent', _('API user agent'));
        o.datatype = 'string';
        o.placeholder = UA;                       // значение один раз, в переменной
        o.rmempty = true;
        o.description = _('User agent reported to SurfEasy API') + '<br>' +
            _('(default "%s")').format(UA);       // в .po попадёт только: (default "%s")

        o = ss.taboption('api', form.Value, 'api_proxy', _('API proxy'));
        o.validate = validateProxyUrl;
        o.datatype = 'string';
        o.placeholder = 'socks5://127.0.0.1:1080';
        o.rmempty = true;
        o.description = _('Additional proxy server used to access SurfEasy API') + '<br>' +
            _('Format: &lt;http|https|socks5|socks5h&gt;://[login:password@]host[:port]');

        o = ss.taboption('api', form.Value, 'api_proxy_file', _('API proxy candidates file'));
        o.datatype = 'string';
        o.placeholder = '/etc/opera-proxy/api-proxies.txt';
        o.rmempty = true;
        o.description = _('Path to text file with candidate proxy servers for SurfEasy API access, one per line;') + '<br>' +
            _('Proxies are tried in order until init/discover succeeds');

        o = ss.taboption('api', form.Value, 'api_proxy_list_url', _('API proxy list URL'));
        o.validate = validateHttpUrl;
        o.datatype = 'string';
        o.placeholder = 'https://example.com/proxies.txt';
        o.rmempty = true;
        o.description = _('URL of a text file with candidate proxy servers for SurfEasy API access;') + '<br>' +
            _('Falls back to the candidates file above if download fails');

        o = ss.taboption('api', form.Value, 'api_proxy_parallel', _('API proxy parallel tests'));
        o.validate = validatePositiveInt;
        o.datatype = 'uinteger';
        o.placeholder = '15';
        o.rmempty = true;
        o.description = _('Number of API proxy candidates tested in parallel when the candidates file is used (default 15)');

        // ===================== Proxy =====================

        o = ss.taboption('proxy', form.Value, 'proxy', _('Upstream proxy'));
        o.validate = validateProxyUrl;
        o.datatype = 'string';
        o.placeholder = 'socks5://127.0.0.1:1080';
        o.rmempty = true;
        o.description = _('Sets base proxy to use for all dial-outs') + '<br>' +
            _('Format: &lt;http|https|socks5|socks5h&gt;://[login:password@]host[:port]') + '<br>' +
            _('Examples: http://user:password@192.168.1.1:3128, socks5://10.0.0.1:1080');

        o = ss.taboption('proxy', form.Value, 'override_proxy_address', _('Override proxy address'));
        o.datatype = 'string';
        o.placeholder = '1.2.3.4:443';
        o.rmempty = true;
        o.description = _('Use fixed proxy address instead of server address returned by SurfEasy API');

        o = ss.taboption('proxy', form.Value, 'proxy_blacklist', _('Proxy blacklist file'));
        o.datatype = 'string';
        o.placeholder = '/etc/opera-proxy/blacklist.txt';
        o.rmempty = true;
        o.description = _('Path to file with blacklisted proxy addresses, one host[:port] per line');

        o = ss.taboption('proxy', form.DynamicList, 'proxy_bypass', _('Proxy bypass'));
        o.validate = validateBypassPattern;
        o.placeholder = '*.local';
        o.rmempty = true;
        o.description = _('List of destination host or URL patterns that should bypass proxying and connect directly;') + '<br>' +
            _('Matching is case-insensitive and supports * in hostnames');

        // ===================== Server =====================

        o = ss.taboption('server', form.ListValue, 'server_selection', _('Server selection'));
        o.value('fastest', _('fastest'));
        o.value('first', _('first'));
        o.value('random', _('random'));
        o.optional = true;
        o.rmempty = true;
        o.description = _('Server selection policy (first/random/fastest) (default fastest)');

        o = ss.taboption('server', form.Value, 'server_selection_timeout', _('Server selection timeout'));
        o.datatype = 'string';
        o.validate = validateDuration;
        o.placeholder = '1m0s';
        o.rmempty = true;
        o.description = _('Timeout given for server selection function to produce result (default 1m0s)');

        o = ss.taboption('server', form.Value, 'server_selection_dl_limit', _('Server selection download limit'));
        o.datatype = 'uinteger';
        o.placeholder = '0';
        o.rmempty = true;
        o.description = _('Restrict amount of downloaded data per connection by fastest server selection (0 = unlimited)');

        var TURL = 'https://ajax.googleapis.com/ajax/libs/angularjs/1.8.2/angular.min.js';
        o = ss.taboption('server', form.Value, 'server_selection_test_url', _('Server selection test URL'));
        o.validate = validateHttpUrl;
        o.datatype = 'string';
        o.placeholder = TURL;
        o.rmempty = true;
        o.description = _('URL used for download benchmark by fastest server selection policy') + '<br>' +
            _('(default "%s")').format(TURL);

        o = ss.taboption('server', form.Value, 'refresh', _('Endpoint refresh interval'));
        o.datatype = 'string';
        o.validate = validateDuration;
        o.placeholder = '4h0m0s';
        o.rmempty = true;
        o.description = _('Login refresh interval (default 4h0m0s)');

        o = ss.taboption('server', form.Value, 'refresh_retry', _('Refresh retry interval'));
        o.datatype = 'string';
        o.validate = validateDuration;
        o.placeholder = '5s';
        o.rmempty = true;
        o.description = _('Login refresh retry interval (default 5s)');

        o = ss.taboption('server', form.Value, 'timeout', _('Request timeout'));
        o.datatype = 'string';
        o.validate = validateDuration;
        o.placeholder = '30s';
        o.rmempty = true;
        o.description = _('Timeout for network operations (default 30s)');
    }
});
