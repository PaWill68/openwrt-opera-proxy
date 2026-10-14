# SPDX-License-Identifier: MIT
#
# LuCI-приложение для opera-proxy. Русский перевод (luci-i18n-opera-proxy-ru)
# luci.mk собирает автоматически из po/ru/opera-proxy.po.
# PKG_VERSION и PKG_RELEASE перезаписываются CI (см. .github/workflows/build.yml).

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Opera Proxy - status, settings and diagnostics
LUCI_DESCRIPTION:=LuCI web interface for the opera-proxy service. Shows the service status and controls it, groups all opera-proxy options in tabs, tests the proxy connection and shows the live log and the service command line.
LUCI_DEPENDS:=+opera-proxy +curl
LUCI_PKGARCH:=all

# Версия пакета. CI подставляет сюда версию upstream и ревизию (например 1.30.0 и 1).
# SDK сам формирует версию основного пакета как "<PKG_VERSION>-r<PKG_RELEASE>" -- поэтому
# "-rN" в PKG_VERSION вписывать нельзя (получится 1.30.0-r1-r1, а в .apk такая версия недопустима).
PKG_VERSION:=1.30.0
PKG_RELEASE:=1

# Пакет перевода luci.mk версионирует отдельно и берёт PKG_PO_VERSION как есть, без ревизии.
# По умолчанию это дата и хеш последнего git-коммита каталога po (26.283.76151~012af1b).
# Задаём явно, чтобы у пакета перевода был тот же вид версии, что и у основного: 1.30.0-r1.
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)

PKG_LICENSE:=MIT

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
