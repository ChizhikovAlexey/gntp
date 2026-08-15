#!/bin/sh
# TypeScript compiles to plain ES modules the browser loads directly —
# no bundler. extension/manifest.json is the Firefox manifest; the
# Chromium variant is derived from it.
set -e
cd "$(dirname "$0")"
PATH="$HOME/.local/node/bin:$PATH"

./node_modules/.bin/tsc -p tsconfig.json

for browser in firefox chromium; do
	out="dist/$browser"
	rm -rf "$out"
	mkdir -p "$out"
	cp -r extension/. "$out/"
	cp -r build/js "$out/js"
done

# Chromium: the "favicon" permission exists only there; host access is
# not needed (icons come from the local /_favicon/ endpoint).
jq '.permissions += ["favicon"] | del(.browser_specific_settings, .host_permissions)' \
	extension/manifest.json > dist/chromium/manifest.json
