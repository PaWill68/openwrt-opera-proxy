# SPDX-License-Identifier: MIT
#
# LuCI-приложение для opera-proxy. Русский перевод (luci-i18n-opera-proxy-ru)
# luci.mk собирает автоматически из po/ru/opera-proxy.po.
# PKG_VERSION и PKG_RELEASE перезаписываются CI (см. .github/workflows/build.yml).

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Opera Proxy
LUCI_DESCRIPTION:=Web interface for the opera-proxy service: status and control, settings, diagnostics
LUCI_DEPENDS:=+opera-proxy +curl
LUCI_PKGARCH:=all

PKG_VERSION:=1.30.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
