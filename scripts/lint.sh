#!/usr/bin/env bash
# Проверки репозитория. Запускаются в CI и локально:  bash scripts/lint.sh
# Нужны: bash, python3, node, (опционально) cc и интернет для проверки через jsmin.
#
# Переменная JSMIN_SRC=/путь/к/jsmin.c позволяет не скачивать исходник jsmin.
set -u
cd "$(dirname "$0")/.."

fail=0
ok()   { printf '  ok     %s\n' "$*"; }
bad()  { printf '  FAIL   %s\n' "$*"; fail=1; }
warn() { printf '  warn   %s\n' "$*"; }

APP=luci-app-opera-proxy
JS_DIR=$APP/htdocs/luci-static/resources/view/opera-proxy
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# JS-файлы LuCI начинаются с 'use strict' и заканчиваются top-level return, поэтому
# для node --check их оборачиваем в функцию.
js_syntax() { { echo 'function wrap(_){'; cat "$1"; echo '}'; } > "$tmp/w.js"; node --check "$tmp/w.js" 2>&1; }

echo "== shell"
sh -n opera-proxy/files/opera-proxy.init && ok "opera-proxy.init: синтаксис" || bad "opera-proxy.init: синтаксис"
for f in scripts/*.sh; do bash -n "$f" && ok "$f: синтаксис" || bad "$f: синтаксис"; done

echo "== окончания строк (на роутере нужен LF)"
crlf=$(grep -rIl $'\r' --exclude-dir=.git . 2>/dev/null || true)
[ -z "$crlf" ] && ok "CRLF не найден" || bad "CRLF в файлах: $crlf"

echo "== json"
while IFS= read -r f; do
    python3 -m json.tool "$f" >/dev/null && ok "$f" || bad "$f"
done < <(find $APP/root -name '*.json')

echo "== js: синтаксис"
for f in $JS_DIR/*.js; do
    out=$(js_syntax "$f") && ok "$(basename "$f")" || { bad "$(basename "$f")"; echo "$out"; }
done

echo "== js: защита от jsmin"
# luci.mk при сборке прогоняет JS через jsmin. Он распознаёт литерал регулярки только
# после ( , = : [ ! & | ? + - ~ * / { } ; -- но не после слова return/typeof/case.
# Регулярка с кавычкой после "return /.../" принимается за начало строки и портит код.
hits=$(grep -nE '(^|[^[:alnum:]_$.])(return|typeof|case|else|void|delete)[[:space:]]+/[^/*]' $JS_DIR/*.js \
        | grep -vE ':[0-9]+:[[:space:]]*//' || true)
[ -z "$hits" ] && ok "нет регулярок сразу после ключевых слов" \
               || { bad "регулярка после ключевого слова (возьмите её в скобки: return (/.../).test(x)):"; echo "$hits"; }

echo "== js: настоящий jsmin из luci-base"
src="${JSMIN_SRC:-}"
if [ -z "$src" ]; then
    curl -fsSL --max-time 30 \
        https://raw.githubusercontent.com/openwrt/luci/master/modules/luci-base/src/jsmin.c \
        -o "$tmp/jsmin.c" 2>/dev/null && src="$tmp/jsmin.c"
fi
if [ -n "$src" ] && cc -O1 -w -o "$tmp/jsmin" "$src" 2>/dev/null; then
    for f in $JS_DIR/*.js; do
        if "$tmp/jsmin" < "$f" > "$tmp/min.js" 2>"$tmp/min.err"; then
            out=$(js_syntax "$tmp/min.js") && ok "$(basename "$f"): $(stat -c%s "$f") -> $(stat -c%s "$tmp/min.js") байт" \
                                           || { bad "$(basename "$f"): минифицированный код не компилируется"; echo "$out"; }
        else
            bad "$(basename "$f"): jsmin завершился с ошибкой: $(cat "$tmp/min.err")"
        fi
    done
else
    warn "jsmin.c недоступен или не собрался -- проверка пропущена"
fi

echo "== makefiles"
for m in opera-proxy/Makefile $APP/Makefile; do
    grep -q '^PKG_VERSION:=' "$m" && grep -q '^PKG_RELEASE:=' "$m" && ok "$m: PKG_VERSION/PKG_RELEASE" || bad "$m: нет PKG_VERSION/PKG_RELEASE (на них опирается CI)"
done

echo "== i18n"
python3 tools/i18n.py update >/dev/null || bad "tools/i18n.py update"
python3 tools/i18n.py check | sed 's/^/  /' ; [ "${PIPESTATUS[0]}" -eq 0 ] && ok "строки корректны" || bad "i18n check"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git ls-files --error-unmatch $APP/po >/dev/null 2>&1; then
    git diff --quiet -- $APP/po && ok ".pot/.po синхронны с JS" \
        || bad ".pot/.po не синхронны с JS: выполните 'python3 tools/i18n.py update' и закоммитьте"
fi

echo
[ "$fail" -eq 0 ] && echo "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" || echo "ЕСТЬ ОШИБКИ"
exit "$fail"
