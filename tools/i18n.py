#!/usr/bin/env python3
"""Инструмент локализации luci-app-opera-proxy (без gettext и без po2lmo).

Раскладка репозитория:

    luci-app-opera-proxy/htdocs/luci-static/resources/view/opera-proxy/*.js   исходники с _('...')
    luci-app-opera-proxy/po/templates/opera-proxy.pot                          шаблон (генерируется)
    luci-app-opera-proxy/po/<lang>/opera-proxy.po                              переводы (правите вы)
    dist/i18n/opera-proxy.<lang>.lmo                                           локальная сборка (не в git)

В пакеты .ipk/.apk перевод попадает не отсюда: luci.mk при сборке сам превращает
po/<lang>/opera-proxy.po в пакет luci-i18n-opera-proxy-<lang>. Команда `build` нужна
только чтобы получить .lmo для ручной проверки на роутере (/usr/lib/lua/luci/i18n/).

Команды:
    python3 tools/i18n.py update   # JS -> .pot, затем слить новые строки в каждый .po
    python3 tools/i18n.py check    # проверка строк, непереведённые, проверка .lmo
    python3 tools/i18n.py build    # .po -> dist/i18n/*.lmo (и проверка результата)
    python3 tools/i18n.py all      # update + check + build

Формат .lmo и хеш (Super Fast Hash) реализованы по спецификации LuCI и po2lmo.c;
на тестовых каталогах результат побайтно совпал с настоящим po2lmo.
"""
import argparse, glob, os, re, struct, sys

DOMAIN = 'opera-proxy'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.join(ROOT, 'luci-app-opera-proxy')
JS_DIR = os.path.join(APP_DIR, 'htdocs', 'luci-static', 'resources', 'view', 'opera-proxy')
PO_DIR = os.path.join(APP_DIR, 'po')
POT = os.path.join(PO_DIR, 'templates', DOMAIN + '.pot')
LMO_DIR = os.path.join(ROOT, 'dist', 'i18n')
JS_ORDER = ['main.js', 'status.js', 'settings.js', 'diag.js']   # порядок строк в .pot

# --------------------------------------------------------------------------
# 1. Извлечение строк из JS
# --------------------------------------------------------------------------
_STR = r"""'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*\""""
_CALL = re.compile(r"(?<![\w$.])_\(\s*((?:%s)(?:\s*\+\s*(?:%s))*)\s*[,)]" % (_STR, _STR))
_LIT = re.compile(_STR)
_ANY_CALL = re.compile(r"(?<![\w$.])_\(\s*([^)\s][^\n]{0,40})")
_ESC = {'n': '\n', 't': '\t', 'r': '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0'}


def js_unescape(lit):
    body, out, i = lit[1:-1], [], 0
    while i < len(body):
        c = body[i]
        if c == '\\' and i + 1 < len(body):
            n = body[i + 1]
            if n == 'u' and re.match(r'[0-9a-fA-F]{4}', body[i + 2:i + 6]):
                out.append(chr(int(body[i + 2:i + 6], 16))); i += 6; continue
            out.append(_ESC.get(n, n)); i += 2; continue
        out.append(c); i += 1
    return ''.join(out)


def extract():
    """-> (OrderedDict msgid -> [(file, line)], [warnings])"""
    found, warns = {}, []
    files = [os.path.join(JS_DIR, f) for f in JS_ORDER if os.path.exists(os.path.join(JS_DIR, f))]
    files += [f for f in sorted(glob.glob(os.path.join(JS_DIR, '*.js'))) if f not in files]
    for path in files:
        src = open(path, encoding='utf-8').read()
        rel = os.path.relpath(path, ROOT).replace(os.sep, '/')
        matched = set()
        for m in _CALL.finditer(src):
            matched.add(m.start())
            msgid = ''.join(js_unescape(l) for l in _LIT.findall(m.group(1)))
            line = src.count('\n', 0, m.start()) + 1
            found.setdefault(msgid, []).append((rel, line))
        for m in _ANY_CALL.finditer(src):          # _( ... ) с не-литералом внутри
            if m.start() not in matched and not m.group(1).startswith(')'):
                line = src.count('\n', 0, m.start()) + 1
                warns.append('%s:%d: _() с не-литералом, строка не извлечена: %s' % (rel, line, m.group(0)[:50]))
    return found, warns


def lint(msgid):
    p = []
    if msgid != msgid.strip():
        p.append('пробелы в начале/конце (LuCI такой ключ в .lmo не найдёт)')
    if re.search(r'\s{2,}', msgid):
        p.append('несколько пробелов подряд (LuCI схлопывает их при поиске)')
    if '\n' in msgid or '\t' in msgid:
        p.append('перевод строки/табуляция внутри msgid')
    if any(ord(ch) > 127 for ch in msgid):
        p.append('не-ASCII символ в msgid')
    if len(msgid.encode('utf-8')) > 4000:
        p.append('слишком длинная строка (po2lmo читает не более 4095 байт)')
    return p

# --------------------------------------------------------------------------
# 2. Чтение / запись .po
# --------------------------------------------------------------------------

def po_unquote(s):
    s = s.strip()
    assert s.startswith('"') and s.endswith('"'), s
    body, out, i = s[1:-1], [], 0
    while i < len(body):
        if body[i] == '\\' and i + 1 < len(body):
            n = body[i + 1]
            out.append({'n': '\n', 't': '\t', '"': '"', '\\': '\\'}.get(n, '\\' + n)); i += 2
        else:
            out.append(body[i]); i += 1
    return ''.join(out)


def po_quote(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\t', '\\t') + '"'


def parse_po(path):
    """-> (entries, obsolete). entry = dict(ctxt,id,str,comments,flags). Первый -- заголовок (id == '')."""
    entries, obsolete, cur, field, comments = [], [], None, None, []
    if not os.path.exists(path):
        return entries, obsolete

    def flush():
        nonlocal cur
        if cur is not None and cur['id'] is not None:
            entries.append(cur)
        cur = None

    for raw in open(path, encoding='utf-8').read().split('\n'):
        line = raw.rstrip('\r')
        if line.startswith('#~'):
            obsolete.append(line); continue
        if line.startswith('#'):
            if cur is not None and field == 'str':
                flush(); comments = []
            comments.append(line); continue
        m = re.match(r'^(msgctxt|msgid|msgstr)\s+(".*")\s*$', line)
        if m:
            kind = m.group(1)
            if kind == 'msgctxt' or (kind == 'msgid' and (cur is None or field == 'str')):
                flush()
                cur = {'ctxt': None, 'id': None, 'str': '', 'comments': comments}; comments = []
            if kind == 'msgctxt':
                cur['ctxt'] = po_unquote(m.group(2)); field = 'ctxt'
            elif kind == 'msgid':
                cur['id'] = po_unquote(m.group(2)); field = 'id'
            else:
                cur['str'] = po_unquote(m.group(2)); field = 'str'
            continue
        if line.startswith('"') and cur is not None:
            k = {'ctxt': 'ctxt', 'id': 'id', 'str': 'str'}[field]
            cur[k] = (cur[k] or '') + po_unquote(line); continue
    flush()
    return entries, obsolete


def write_po(path, header_str, items, obsolete, template=False):
    """items: [(msgid, msgstr, [refs])]"""
    out = []
    out.append('msgid ""')
    hdr = header_str.split('\n')
    if hdr and hdr[-1] == '':
        hdr = hdr[:-1]
        out.append('msgstr ""')
        out += [po_quote(h + '\n') for h in hdr]
    else:
        out.append('msgstr ' + po_quote(header_str))
    out.append('')
    for msgid, msgstr, refs in items:
        files = []                       # только имена файлов: номера строк делали бы
        for f, _ln in refs:              # каждую правку JS "изменением" .po/.pot
            if f not in files:
                files.append(f)
        for f in files:
            out.append('#: %s' % f)
        out.append('msgid ' + po_quote(msgid))
        out.append('msgstr ' + po_quote('' if template else msgstr))
        out.append('')
    if obsolete:
        out += obsolete + ['']
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))


POT_HEADER = ('Project-Id-Version: luci-app-opera-proxy\n'
              'MIME-Version: 1.0\n'
              'Content-Type: text/plain; charset=UTF-8\n'
              'Content-Transfer-Encoding: 8bit\n')

# --------------------------------------------------------------------------
# 3. LMO (формат и хеш по спецификации LuCI / po2lmo.c)
# --------------------------------------------------------------------------
M32 = 0xFFFFFFFF


def sfh_hash(data, init=None):
    """Super Fast Hash, как sfh_hash(data, len, len) в LuCI. Одиночные байты -- знаковые."""
    n = len(data)
    if n <= 0:
        return 0
    h = n if init is None else init
    rem, words = n & 3, n >> 2
    p = 0
    g16 = lambda i: data[i] | (data[i + 1] << 8)
    sg = lambda b: b - 256 if b > 127 else b
    for _ in range(words):
        h = (h + g16(p)) & M32
        tmp = ((g16(p + 2) << 11) ^ h) & M32
        h = ((h << 16) & M32) ^ tmp
        p += 4
        h = (h + (h >> 11)) & M32
    if rem == 3:
        h = (h + g16(p)) & M32
        h ^= (h << 16) & M32
        h ^= (sg(data[p + 2]) << 18) & M32
        h = (h + (h >> 11)) & M32
    elif rem == 2:
        h = (h + g16(p)) & M32
        h ^= (h << 11) & M32
        h = (h + (h >> 17)) & M32
    elif rem == 1:
        h = (h + sg(data[p])) & M32
        h ^= (h << 10) & M32
        h = (h + (h >> 1)) & M32
    h ^= (h << 3) & M32;  h = (h + (h >> 5)) & M32
    h ^= (h << 4) & M32;  h = (h + (h >> 17)) & M32
    h ^= (h << 25) & M32; h = (h + (h >> 6)) & M32
    return h


def po_to_lmo(entries):
    """Повторяет po2lmo.c: payload (значения, выровненные по 4) + отсортированный индекс + смещение индекса."""
    payload, index, offset = bytearray(), [], 0

    def add(key_id, val_id, value):
        nonlocal offset
        index.append((key_id, val_id, offset, len(value)))
        pad = (4 - len(value) % 4) % 4
        payload.extend(value + b'\0' * pad)
        offset += len(value) + pad

    for e in entries:
        if e['id'] == '':                                  # заголовок -> Plural-Forms под ключом 0
            for part in e['str'].split('\n'):
                if part.lower().startswith('plural-forms: '):
                    add(0, 0, part[14:].encode('utf-8'))
                    break
            continue
        if not e['str']:
            continue
        key = ((e['ctxt'] + '\x01') if e['ctxt'] is not None else '') + e['id']
        kb, vb = key.encode('utf-8'), e['str'].encode('utf-8')
        key_id = sfh_hash(kb)
        if key_id != sfh_hash(vb):                         # как в po2lmo: идентичные пары пропускаются
            add(key_id, 1, vb)
    index.sort(key=lambda t: t[0])
    ids = [t[0] for t in index if t[0] != 0]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise SystemExit('Коллизия хешей ключей (две разные строки дают один key_id): %s' % sorted(dup))
    blob = bytearray(payload)
    for t in index:
        blob += struct.pack('>IIII', *t)
    blob += struct.pack('>I', offset)
    return bytes(blob)


def lmo_lookup(blob, msgid, ctxt=None):
    """Поиск как у рантайма: бинарный поиск по key_id в индексе."""
    idx_off = struct.unpack('>I', blob[-4:])[0]
    n = (len(blob) - 4 - idx_off) // 16
    key = ((ctxt + '\x01') if ctxt is not None else '') + msgid
    want = sfh_hash(key.encode('utf-8'))
    lo, hi = 0, n - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        kid, vid, off, ln = struct.unpack('>IIII', blob[idx_off + mid * 16: idx_off + mid * 16 + 16])
        if kid == want:
            return blob[off:off + ln].decode('utf-8')
        lo, hi = (mid + 1, hi) if kid < want else (lo, mid - 1)
    return None

# --------------------------------------------------------------------------
# 4. Команды
# --------------------------------------------------------------------------

def langs():
    return sorted(d for d in os.listdir(PO_DIR)
                  if d != 'templates' and os.path.exists(os.path.join(PO_DIR, d, DOMAIN + '.po')))


def cmd_update(_args=None):
    found, warns = extract()
    for w in warns:
        print('ПРЕДУПРЕЖДЕНИЕ:', w)
    write_po(POT, POT_HEADER, [(k, '', v) for k, v in found.items()], [], template=True)
    print('%s: %d строк' % (os.path.relpath(POT, ROOT), len(found)))
    for lang in langs():
        path = os.path.join(PO_DIR, lang, DOMAIN + '.po')
        entries, obsolete = parse_po(path)
        header = next((e['str'] for e in entries if e['id'] == ''), POT_HEADER + 'Language: %s\n' % lang)
        old = {e['id']: e['str'] for e in entries if e['id'] != '' and e['ctxt'] is None}
        items = [(k, old.get(k, ''), v) for k, v in found.items()]
        gone = [k for k in old if k not in found]
        new = [k for k in found if not old.get(k)]
        obs = [l for l in obsolete if l.startswith('#~')]
        for k in gone:
            if old[k]:
                obs += ['#~ msgid ' + po_quote(k), '#~ msgstr ' + po_quote(old[k]), '']
        write_po(path, header, items, obs)
        print('%s: %d строк, без перевода: %d, устарело: %d' % (os.path.relpath(path, ROOT), len(items), len(new), len(gone)))
        for k in new:
            print('    нет перевода:', k)


def cmd_check(_args=None):
    found, warns = extract()
    bad = 0
    for w in warns:
        print('ПРЕДУПРЕЖДЕНИЕ:', w)
    for k, refs in found.items():
        for p in lint(k):
            bad += 1
            print('ОШИБКА %s:%d: %s -> %r' % (refs[0][0], refs[0][1], p, k))
    for lang in langs():
        entries, _ = parse_po(os.path.join(PO_DIR, lang, DOMAIN + '.po'))
        tr = {e['id']: e['str'] for e in entries if e['id'] != ''}
        miss = [k for k in found if not tr.get(k)]
        extra = [k for k in tr if k not in found]
        for k in found:
            if tr.get(k) and k.count('%s') + k.count('%d') != tr[k].count('%s') + tr[k].count('%d'):
                bad += 1; print('ОШИБКА [%s] разное число %%s/%%d: %r' % (lang, k))
            if tr.get(k) and ('<' in tr[k]) != ('<' in k):
                bad += 1; print('ОШИБКА [%s] HTML-теги не совпадают: %r' % (lang, k))
        print('[%s] строк в JS: %d, переведено: %d, без перевода: %d, лишних в .po: %d' %
              (lang, len(found), len(found) - len(miss), len(miss), len(extra)))
        for k in miss:
            print('    нет перевода:', k)
    print('Проблем: %d' % bad)
    return 1 if bad else 0


def cmd_build(_args=None):
    found, _ = extract()
    os.makedirs(LMO_DIR, exist_ok=True)
    rc = 0
    for lang in langs():
        entries, _ = parse_po(os.path.join(PO_DIR, lang, DOMAIN + '.po'))
        blob = po_to_lmo(entries)
        out = os.path.join(LMO_DIR, '%s.%s.lmo' % (DOMAIN, lang))
        open(out, 'wb').write(blob)
        tr = {e['id']: e['str'] for e in entries if e['id'] != ''}
        ok = sum(1 for k in found if tr.get(k) and lmo_lookup(blob, k) == tr[k])
        need = sum(1 for k in found if tr.get(k) and tr[k] != k)
        print('%s: %d байт, строк из JS найдено в .lmo: %d из %d переведённых' % (os.path.relpath(out, ROOT), len(blob), ok, need))
        if ok != need:
            rc = 1
    return rc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['update', 'check', 'build', 'all'])
    a = ap.parse_args()
    if a.command == 'update': cmd_update()
    elif a.command == 'check': sys.exit(cmd_check())
    elif a.command == 'build': sys.exit(cmd_build())
    else:
        cmd_update(); rc = cmd_check(); rc |= cmd_build(); sys.exit(rc)


if __name__ == '__main__':
    main()
